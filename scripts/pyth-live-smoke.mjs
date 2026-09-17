#!/usr/bin/env node
/**
 * Manually-invoked live Pyth Pro smoke test. Reads PYTH_PRO_API_KEY from
 * the process environment (secure/untracked storage) — never prints the
 * credential or a complete signed payload. Run only when a ROTATED
 * credential is installed; not part of CI.
 */
import WebSocket from "ws";

const key = process.env.PYTH_PRO_API_KEY;
if (!key || key.length < 8) { console.error("PYTH_PRO_API_KEY is not set in the environment"); process.exit(1); }
const endpoints = process.argv.includes("--local")
  ? ["ws://127.0.0.1:45678", "ws://127.0.0.1:45678", "ws://127.0.0.1:45678"]
  : process.env.PYTH_PRO_ENDPOINTS
    ? process.env.PYTH_PRO_ENDPOINTS.split(",")
    : [
        "wss://pyth-lazer-0.dourolabs.app/v1/stream",
        "wss://pyth-lazer-1.dourolabs.app/v1/stream",
        "wss://pyth-lazer-2.dourolabs.app/v1/stream",
      ];
const feedId = Number(process.env.PYTH_PRO_FEED_ID ?? "33");
console.log(`connecting to ${endpoints.length} endpoints, feed ${feedId}...`);

const sockets = [];
let accepted = null;
let conflicts = 0;

for (const [i, url] of endpoints.entries()) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
  sockets.push({ ws, url, name: `lazer-${i}`, subscribed: false, lastTs: 0 });
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      type: "subscribe",
      subscriptionId: 1,
      priceFeedIds: [feedId],
      properties: ["price", "exponent", "confidence", "marketSession", "feedUpdateTimestamp"],
      formats: ["solana"],
      channel: "fixed_rate@200ms",
      ignoreInvalidFeeds: false,
    }));
  });
  ws.addEventListener("message", (event) => {
    let parsed;
    try { parsed = JSON.parse(typeof event.data === "string" ? event.data : "{}"); } catch { return; }
    if (parsed.type === "subscribed") { sockets[i].subscribed = true; console.log(`${sockets[i].name}: subscribed`); }
    else if (parsed.type === "error") { console.log(`${sockets[i].name}: ERROR ${JSON.stringify(parsed.error).slice(0, 120)}`); process.exitCode = 2; }
    else if (parsed.type === "subscriptionError") { console.log(`${sockets[i].name}: subscription rejected ${JSON.stringify(parsed.error).slice(0, 120)}`); process.exitCode = 2; }
    else if (parsed.type === "streamUpdated") {
      const feed = parsed.parsed?.priceFeeds?.find((f) => f.priceFeedId === feedId);
      const ts = feed?.feedUpdateTimestamp ?? 0;
      const solanaHex = parsed.solana?.data ?? "";
      const payloadHash = (h = 0x811c9dc5) => { // FNV-1a over the message bytes
        const bytes = Buffer.from(solanaHex, "hex");
        for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
        return h.toString(16);
      };
      if (accepted && accepted.ts === ts && accepted.hash !== payloadHash()) {
        console.log(`CONFLICT at ts=${ts}: quarantining (no submission)`);
        process.exitCode = 3;
        return;
      }
      if (!accepted || ts > accepted.ts) {
        accepted = { ts, hash: payloadHash(), price: feed?.price };
        console.log(`${sockets[i].name}: update ts=${ts} price=${feed?.price} (payload redacted)`);
      }
    }
  });
  ws.addEventListener("close", () => { console.log(`${sockets[i].name}: closed`); });
  ws.addEventListener("error", (e) => { console.log(`${sockets[i].name}: socket error`); });
}

setTimeout(() => {
  const healthy = sockets.filter((s) => s.subscribed).length;
  console.log(`\nsmoke result: ${healthy}/3 endpoints subscribed; latest accepted update ts=${accepted?.ts ?? "none"} (payload redacted)`);
  if (healthy < 2) { console.error("redundancy floor (<2 endpoints) broken"); process.exit(1); }
  if (accepted === null) { console.error("no update received"); process.exit(1); }
  for (const s of sockets) s.ws.close();
  process.exit(0);
}, 10_000);
