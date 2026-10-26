#!/usr/bin/env node
/**
 * Read-only production health check: exits 1 and prints one line per problem.
 * Run it from cron / an uptime monitor every minute. Covers the outage modes
 * seen on devnet: signer wallets out of SOL, stale oracle snapshots, a stalled
 * market maker, and keeper commits that stopped landing.
 *
 *   MM_STATUS_URL      market-maker status (default https://api.ansht.in/v1/mm/status)
 *   SOLANA_RPC_URL     read RPC (default devnet)
 *   ALERT_WEBHOOK_URL  optional; failures are POSTed as {"content": "..."} (Slack/Discord style)
 *   SKIP_MARKETS       comma-separated symbols to ignore (a market known to be unpriced)
 *   MIN_SOL_KEEPER / MIN_SOL_BOT / MAX_ORACLE_AGE_S (reporter markets, post every ~4 s) / MAX_PYTH_AGE_S (Pyth markets refresh every ~30 s, and on demand before orders) / MAX_TICK_AGE_S / MAX_COMMIT_AGE_S
 */
import fs from "node:fs";

const OFFSET_PUBLISH_TIMESTAMP = 69; // oracle snapshot layout (programs/equinox/src/oracle_snapshot.rs)

/** Pure: every failed check, as readable strings. `snapshots` maps symbol -> publish time (s) or null. */
export function evaluate({ nowMs, status, balances, snapshots }, limits) {
  const problems = [];
  if (!status?.running) return ["market maker status unreachable or not running"];
  const tickAge = (nowMs - status.lastTickAt) / 1000;
  if (!(tickAge <= limits.maxTickAgeS)) problems.push(`market maker last tick ${Math.round(tickAge)}s ago`);

  for (const [role, { address, sol }] of Object.entries(balances)) {
    const min = role === "keeper" ? limits.minSolKeeper : limits.minSolBot;
    if (!(sol >= min)) problems.push(`${role} wallet ${address} holds ${sol} SOL (min ${min})`);
  }

  for (const [symbol, market] of Object.entries(status.markets ?? {})) {
    if (limits.skip?.includes(symbol)) continue;
    // A Pyth market can legitimately be quiet while its session is closed; reporter markets never are.
    if (market.reporter || status.marketOpen) {
      const published = snapshots[symbol];
      const age = published == null ? Infinity : nowMs / 1000 - published;
      const max = market.reporter ? limits.maxOracleAgeS : limits.maxPythAgeS;
      if (!(age <= max)) problems.push(`${symbol} oracle snapshot ${Number.isFinite(age) ? `${Math.round(age)}s old` : "unreadable"}`);
    }
    const lastCommit = market.keeper?.lastCommitAt; // null right after a restart: unknown, not failed
    if (lastCommit != null && (nowMs - lastCommit) / 1000 > limits.maxCommitAgeS) problems.push(`${symbol} last rollup commit ${Math.round((nowMs - lastCommit) / 60000)} min ago`);
  }
  return problems;
}

async function rpc(url, method, params) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  const env = process.env;
  const limits = {
    minSolKeeper: Number(env.MIN_SOL_KEEPER ?? 1), minSolBot: Number(env.MIN_SOL_BOT ?? 0.1),
    skip: (env.SKIP_MARKETS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    maxOracleAgeS: Number(env.MAX_ORACLE_AGE_S ?? 30), maxPythAgeS: Number(env.MAX_PYTH_AGE_S ?? 120), maxTickAgeS: Number(env.MAX_TICK_AGE_S ?? 30), maxCommitAgeS: Number(env.MAX_COMMIT_AGE_S ?? 5400),
  };
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const deployment = JSON.parse(fs.readFileSync(new URL("../config/equinox-deployment.json", import.meta.url), "utf8"));
  let status = null;
  try { status = await (await fetch(env.MM_STATUS_URL ?? "https://api.ansht.in/v1/mm/status", { signal: AbortSignal.timeout(10_000) })).json(); } catch { /* reported by evaluate */ }

  const balances = {}, snapshots = {};
  if (status?.running) {
    const keeper = Object.values(status.markets ?? {}).find((m) => m.keeper?.key)?.keeper.key;
    for (const [role, address] of Object.entries({ keeper, maker: status.maker, taker: status.taker })) {
      if (address) balances[role] = { address, sol: (await rpc(rpcUrl, "getBalance", [address, { commitment: "confirmed" }])).value / 1e9 };
    }
    for (const { symbol, oracleSnapshot } of deployment.markets ?? []) {
      const info = await rpc(rpcUrl, "getAccountInfo", [oracleSnapshot, { encoding: "base64", commitment: "confirmed" }]).catch(() => null);
      const data = info?.value && Buffer.from(info.value.data[0], "base64");
      snapshots[symbol] = data && data.length >= OFFSET_PUBLISH_TIMESTAMP + 8 ? Number(data.readBigUInt64LE(OFFSET_PUBLISH_TIMESTAMP)) : null;
    }
  }

  const problems = evaluate({ nowMs: Date.now(), status, balances, snapshots }, limits);
  if (!problems.length) return console.log("ok");
  const message = `Equinox health check failed:\n${problems.map((p) => `- ${p}`).join("\n")}`;
  console.error(message);
  if (env.ALERT_WEBHOOK_URL) await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: message }) }).catch(() => {});
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
