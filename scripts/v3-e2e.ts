#!/usr/bin/env node
/**
 * Fresh-market end-to-end runner: seats, L1 snapshot, custody, ER trade/close,
 * L1 restore + reconciliation, withdrawal and status.
 * Every transaction is simulated before it is sent. Build and run:
 *   npx esbuild scripts/v3-e2e.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=node_modules/.cache/v3-e2e.mjs
 *   node node_modules/.cache/v3-e2e.mjs <seats|snapshot|fund|trade|take|close|restore|lookup|withdraw|quote|status>
 * Delegation and commit reuse v3-tsla-delegation.ts and v3-sharded-commit.mjs.
 */
import fs from "node:fs";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadPythKeeperConfig, PythKeeper } from "../lib/server/pyth-keeper";
import { createV3TraderSeat, depositCollateralV3, placeOrderV3, reconcileVaultV3, withdrawCollateralV3, type V3ExecutionAccounts } from "../clients/stockstream/src/abi/v3-instructions";
import deployment from "../config/stockstream-deployment.json";

const L1 = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const ER = new Connection(deployment.magicBlock.rpc, "confirmed");
const STATE_PATH = process.env.V3_LIFECYCLE_STATE_PATH ?? "/tmp/opencode/v3-e2e-tsla-state.json";
const TAKER_PATH = process.env.V3_TAKER_KEY_PATH ?? "/tmp/opencode/v3-e2e-taker.json";
const PYTH_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
const PYTH_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
const MAKER_SEAT = 0, TAKER_SEAT = 1;
const COLLATERAL = 1_000_000_000n; // 1,000 test tokens (6 decimals) per seat
const QUANTITY = 10n;

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
const save = (patch: Record<string, unknown>) => fs.writeFileSync(STATE_PATH, JSON.stringify({ ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")), ...patch }, null, 2), { mode: 0o600 });
const readKey = (path: string) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8"))));
const maker = readKey(`${process.env.HOME}/.config/solana/id.json`);
function taker(): Keypair {
  if (!fs.existsSync(TAKER_PATH)) fs.writeFileSync(TAKER_PATH, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return readKey(TAKER_PATH);
}
const core = new PublicKey(state.core);
const snapshot = new PublicKey(state.oracleSnapshot);
const mint = new PublicKey(state.mint);
const vault = new PublicKey(state.vault);
const { bookPages, seatShards, eventShards } = state.v3Accounts as { bookPages: string[]; seatShards: string[]; eventShards: string[] };
const execution = (authority: PublicKey): V3ExecutionAccounts => ({ core, bookPages, seatShards, eventShards, authority, oracleSnapshot: snapshot });

async function send(connection: Connection, name: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  // Matching can exceed the 200k default; L1 Pyth transactions keep fixed instruction indices.
  const tx = new Transaction().add(...(connection === ER ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })] : []), ...ixs);
  tx.feePayer = signers[0].publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${name}: simulation ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-15).join("\n")}`);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`${name}: ${signature} failed ${JSON.stringify(result.value.err)}`);
  console.log(`${name}: ${signature} units=${sim.value.unitsConsumed}`);
  const events = [...(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")).events ?? []), { name, signature, domain: connection === ER ? "er" : "l1" }];
  save({ events });
  return signature;
}

/** Sends a v0 transaction through the market's lookup table (custody txs exceed the legacy size limit). */
async function sendV0(name: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const table = (await L1.getAddressLookupTable(new PublicKey(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")).lookupTable))).value;
  if (!table) throw new Error("market lookup table missing; run the lookup stage");
  const latest = await L1.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: latest.blockhash, instructions: ixs }).compileToV0Message([table]));
  tx.sign(signers);
  const sim = await L1.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${name}: simulation ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-15).join("\n")}`);
  const signature = await L1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const result = await L1.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`${name}: ${signature} failed ${JSON.stringify(result.value.err)}`);
  console.log(`${name}: ${signature} units=${sim.value.unitsConsumed} bytes=${tx.serialize().length}`);
  save({ events: [...(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")).events ?? []), { name, signature, domain: "l1" }] });
}

function readSnapshot(data: Buffer) {
  return {
    feedId: data.readUInt32LE(44), channel: data[48], exponent: data.readInt32LE(49), price: data.readBigInt64LE(53),
    confidence: data.readBigUInt64LE(61), publishTime: Number(data.readBigUInt64LE(69)), sequence: data.readBigUInt64LE(77),
    session: data[85], tradingStatus: data[86], authenticated: data[87],
  };
}

let keeper: PythKeeper | undefined;
async function refreshSnapshot() {
  if (!keeper) {
    const treasury = new PublicKey((await L1.getAccountInfo(PYTH_STORAGE))!.data.subarray(40, 72));
    keeper = new PythKeeper(loadPythKeeperConfig({
      ...process.env, PYTH_PRO_FEED_ID: String(deployment.oracle.feedId), PYTH_PRO_MIN_CHANNEL: deployment.oracle.channel,
      PYTH_PRO_ENDPOINTS: process.env.PYTH_PRO_ENDPOINTS ?? [0, 1, 2].map((i) => `wss://pyth-lazer-${i}.dourolabs.app/v1/stream`).join(","),
      STOCKSTREAM_MARKET_ADDRESS: core.toBase58(), KEEPER_PUBLIC_KEY: maker.publicKey.toBase58(),
      PYTH_PROGRAM_ADDRESS: PYTH_PROGRAM.toBase58(), PYTH_STORAGE_ADDRESS: PYTH_STORAGE.toBase58(), PYTH_TREASURY_ADDRESS: treasury.toBase58(),
    }));
    (keeper as unknown as { treasury: PublicKey }).treasury = treasury;
  }
  const treasury = (keeper as unknown as { treasury: PublicKey }).treasury;
  const update = await keeper.fetchSignedUpdate();
  await send(L1, "L1 snapshot update", keeper.buildV3SnapshotTransaction(update, {
    snapshot, core, payer: maker.publicKey, pythProgram: PYTH_PROGRAM, storage: PYTH_STORAGE, treasury,
    systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  }), [maker]);
  const view = readSnapshot((await L1.getAccountInfo(snapshot, "confirmed"))!.data);
  if (view.authenticated !== 1 || view.feedId !== deployment.oracle.feedId || view.channel !== deployment.oracle.channelId || view.exponent !== deployment.oracle.exponent) {
    throw new Error(`snapshot readback mismatch ${JSON.stringify(view, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
  }
  return view;
}

/** Waits until ER serves the L1 snapshot at `sequence`; returns the lag in ms. */
async function waitForEr(sequence: bigint) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const info = await ER.getAccountInfo(snapshot, "processed");
    if (info && info.owner.equals(new PublicKey(deployment.programId)) && readSnapshot(info.data).sequence >= sequence) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`ER did not observe snapshot sequence ${sequence} within 10 s`);
}

function readSeat(data: Buffer, seat: number) {
  const base = 44 + (seat % 32) * 256;
  return {
    trader: new PublicKey(data.subarray(base + 1, base + 33)).toBase58(),
    available: data.readBigInt64LE(base + 40).toString(), reservedMargin: data.readBigInt64LE(base + 56).toString(),
    basePosition: data.readBigInt64LE(base + 72).toString(), quoteEntryValue: data.readBigInt64LE(base + 88).toString(),
    realizedPnl: data.readBigInt64LE(base + 104).toString(),
  };
}

async function status() {
  const seat0 = new PublicKey(seatShards[0]);
  const [l1Seat, erSeat, l1Core, snap, vaultBalance] = await Promise.all([
    L1.getAccountInfo(seat0), ER.getAccountInfo(seat0).catch(() => null), L1.getAccountInfo(core),
    L1.getAccountInfo(snapshot), L1.getTokenAccountBalance(vault).then((b) => b.value.amount).catch(() => null),
  ]);
  const out = {
    core: core.toBase58(), l1CoreOwner: l1Core?.owner.toBase58(), vaultBalance,
    snapshot: snap ? readSnapshot(snap.data) : null,
    l1: l1Seat ? { owner: l1Seat.owner.toBase58(), maker: readSeat(l1Seat.data, MAKER_SEAT), taker: readSeat(l1Seat.data, TAKER_SEAT) } : null,
    er: erSeat ? { owner: erSeat.owner.toBase58(), maker: readSeat(erSeat.data, MAKER_SEAT), taker: readSeat(erSeat.data, TAKER_SEAT) } : null,
  };
  console.log(JSON.stringify(out, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
}

const stage = process.argv[2];
if (stage === "seats") {
  const t = taker();
  if ((await L1.getBalance(t.publicKey)) < 50_000_000) {
    await send(L1, "fund taker", [SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: t.publicKey, lamports: 100_000_000 })], [maker]);
  }
  const seats = { core, seatShards, eventShards };
  await send(L1, "create maker seat", [createV3TraderSeat({ ...seats, trader: maker.publicKey }, MAKER_SEAT)], [maker]);
  await send(L1, "create taker seat", [createV3TraderSeat({ ...seats, trader: t.publicKey }, TAKER_SEAT)], [t]);
  save({ taker: t.publicKey.toBase58(), seats: { maker: MAKER_SEAT, taker: TAKER_SEAT } });
} else if (stage === "snapshot") {
  const view = await refreshSnapshot();
  console.log(JSON.stringify(view, (_, v) => typeof v === "bigint" ? v.toString() : v));
} else if (stage === "fund") {
  // Each trader funds their own seat from a token account they own.
  for (const [seat, trader] of [[MAKER_SEAT, maker], [TAKER_SEAT, taker()]] as const) {
    const shard = (await L1.getAccountInfo(new PublicKey(seatShards[Math.floor(seat / 32)])))!.data;
    if (BigInt(readSeat(shard, seat).available) > 0n) continue;
    const source = await getOrCreateAssociatedTokenAccount(L1, maker, mint, trader.publicKey);
    if (source.amount < COLLATERAL) await mintTo(L1, maker, mint, source.address, maker, COLLATERAL - source.amount);
    await refreshSnapshot();
    await send(L1, `deposit seat ${seat}`, [depositCollateralV3({
      core, seatShard: seatShards[Math.floor(seat / 32)], eventShards, authority: trader.publicKey, source: source.address,
      vault, mint, tokenProgram: TOKEN_PROGRAM_ID, oracleSnapshot: snapshot,
    }, seat, COLLATERAL)], [trader]);
  }
  await status();
} else if (stage === "trade") {
  const t = taker();
  // Ask slightly above the oracle so it rests; the taker bid crosses it.
  let view = await refreshSnapshot();
  console.log(`ER snapshot lag: ${await waitForEr(view.sequence)} ms (sequence ${view.sequence})`);
  const askPrice = view.price + view.price / 1000n;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await send(ER, "ER maker ask (post-only)", [placeOrderV3({
    ...execution(maker.publicKey), seatIndex: MAKER_SEAT, side: "ask", quantity: QUANTITY, priceOrOffset: askPrice,
    expiresAt, clientOrderId: 1n, postOnly: true,
  })], [maker]);
  view = await refreshSnapshot();
  console.log(`ER snapshot lag: ${await waitForEr(view.sequence)} ms (sequence ${view.sequence})`);
  await send(ER, "ER taker bid (IOC)", [placeOrderV3({
    ...execution(t.publicKey), seatIndex: TAKER_SEAT, side: "bid", quantity: QUANTITY, priceOrOffset: askPrice,
    expiresAt, clientOrderId: 2n, immediateOrCancel: true,
  })], [t]);
  save({ trade: { askPrice: askPrice.toString(), quantity: QUANTITY.toString() } });
  await status();
} else if (stage === "take") {
  // Crosses the resting maker ask; the fill executes at the maker's price.
  const view = await refreshSnapshot();
  console.log(`ER snapshot lag: ${await waitForEr(view.sequence)} ms (sequence ${view.sequence})`);
  await send(ER, "ER taker bid (IOC)", [placeOrderV3({
    ...execution(taker().publicKey), seatIndex: TAKER_SEAT, side: "bid", quantity: QUANTITY, priceOrOffset: view.price + view.price / 500n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600), clientOrderId: 2n, immediateOrCancel: true,
  })], [taker()]);
  await status();
} else if (stage === "close") {
  // Flattens both positions: maker bids below the oracle, taker sells into it reduce-only.
  const t = taker();
  let view = await refreshSnapshot();
  console.log(`ER snapshot lag: ${await waitForEr(view.sequence)} ms (sequence ${view.sequence})`);
  const bidPrice = view.price - view.price / 1000n;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await send(ER, "ER maker bid (post-only, reduce-only)", [placeOrderV3({
    ...execution(maker.publicKey), seatIndex: MAKER_SEAT, side: "bid", quantity: QUANTITY, priceOrOffset: bidPrice,
    expiresAt, clientOrderId: 3n, postOnly: true, reduceOnly: true,
  })], [maker]);
  view = await refreshSnapshot();
  console.log(`ER snapshot lag: ${await waitForEr(view.sequence)} ms (sequence ${view.sequence})`);
  await send(ER, "ER taker ask (IOC, reduce-only)", [placeOrderV3({
    ...execution(t.publicKey), seatIndex: TAKER_SEAT, side: "ask", quantity: QUANTITY, priceOrOffset: bidPrice,
    expiresAt, clientOrderId: 4n, immediateOrCancel: true, reduceOnly: true,
  })], [t]);
  save({ close: { bidPrice: bidPrice.toString(), quantity: QUANTITY.toString() } });
  await status();
} else if (stage === "restore") {
  // Waits for MagicBlock to hand all 27 accounts back, then reconciles, which finalizes the restore.
  const bundle = [core, ...[...bookPages, ...seatShards, ...eventShards].map((key) => new PublicKey(key))];
  const program = new PublicKey(deployment.programId);
  for (let attempt = 0; ; attempt += 1) {
    const owned = (await L1.getMultipleAccountsInfo(bundle)).filter((info) => info?.owner.equals(program)).length;
    console.log(`restored ${owned}/27`);
    if (owned === 27) break;
    if (attempt === 60) throw new Error("undelegation callback did not return all 27 accounts");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  await send(L1, "L1 reconcile + finalize restore", [reconcileVaultV3({
    ...execution(maker.publicKey), vault, mint, tokenProgram: TOKEN_PROGRAM_ID,
  })], [maker]);
  const bytes = (await L1.getAccountInfo(core))!.data;
  console.log(JSON.stringify({ delegationStatus: bytes[197], commitPhase: bytes[372], reconciliation: bytes[370], mode: bytes[11] }));
} else if (stage === "lookup") {
  // One table per market: the 27-account bundle plus every custody/oracle account.
  if (state.lookupTable) { console.log(`lookup table ${state.lookupTable}`); process.exit(0); }
  const program = new PublicKey(deployment.programId);
  const addresses = [core, ...[...bookPages, ...seatShards, ...eventShards].map((key) => new PublicKey(key)), vault, mint, snapshot,
    PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), core.toBuffer()], program)[0], TOKEN_PROGRAM_ID, program];
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: maker.publicKey, payer: maker.publicKey, recentSlot: await L1.getSlot("finalized") });
  await send(L1, "create lookup table", [create], [maker]);
  for (let start = 0; start < addresses.length; start += 20) {
    await send(L1, `extend lookup table ${start}`, [AddressLookupTableProgram.extendLookupTable({
      lookupTable: table, authority: maker.publicKey, payer: maker.publicKey, addresses: addresses.slice(start, start + 20),
    })], [maker]);
  }
  save({ lookupTable: table.toBase58() });
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // extended entries activate after one slot
  console.log(`lookup table ${table.toBase58()} (${addresses.length} addresses)`);
} else if (stage === "withdraw") {
  const coreBytes = (await L1.getAccountInfo(core))!.data;
  const buffer = coreBytes.readBigInt64LE(1656);
  for (const [seat, trader] of [[MAKER_SEAT, maker], [TAKER_SEAT, taker()]] as const) {
    const view = readSeat((await L1.getAccountInfo(new PublicKey(seatShards[Math.floor(seat / 32)])))!.data, seat);
    if (view.basePosition !== "0") throw new Error(`seat ${seat} still has a position`);
    const available = BigInt(view.available);
    const pnl = BigInt(view.realizedPnl);
    // Only `available` is withdrawable; realized losses and the buffer must stay covered.
    const amount = (pnl < 0n ? available + pnl : available) - buffer;
    if (amount <= 0n) continue;
    const destination = await getOrCreateAssociatedTokenAccount(L1, maker, mint, trader.publicKey);
    await refreshSnapshot();
    await sendV0(`withdraw seat ${seat} (${amount})`, [withdrawCollateralV3({
      core, bookPages, seatShards, eventShards, authority: trader.publicKey, destination: destination.address,
      mint, vault, vaultAuthority: PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), core.toBuffer()], new PublicKey(deployment.programId))[0],
      tokenProgram: TOKEN_PROGRAM_ID, oracleSnapshot: snapshot,
    }, seat, amount)], [trader]);
  }
  await status();
} else if (stage === "quote") {
  // Operator liquidity: post-only bids and asks around the oracle from the maker seat.
  const shard = (await L1.getAccountInfo(new PublicKey(seatShards[0])))!.data;
  if (BigInt(readSeat(shard, MAKER_SEAT).available) < COLLATERAL / 2n) {
    const source = await getOrCreateAssociatedTokenAccount(L1, maker, mint, maker.publicKey);
    const amount = source.amount < COLLATERAL ? source.amount : COLLATERAL;
    if (amount === 0n) throw new Error("maker wallet holds no collateral to deposit");
    await refreshSnapshot();
    await send(L1, `deposit maker (${amount})`, [depositCollateralV3({ core, seatShard: seatShards[0], eventShards, authority: maker.publicKey, source: source.address, vault, mint, tokenProgram: TOKEN_PROGRAM_ID, oracleSnapshot: snapshot }, MAKER_SEAT, amount)], [maker]);
  }
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30);
  for (const [index, bps] of [10n, 25n, 50n].entries()) {
    for (const side of ["bid", "ask"] as const) {
      const view = await refreshSnapshot();
      const price = side === "bid" ? view.price - (view.price * bps) / 10_000n : view.price + (view.price * bps) / 10_000n;
      await send(L1, `quote ${side} ${bps}bps`, [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), placeOrderV3({
        ...execution(maker.publicKey), seatIndex: MAKER_SEAT, side, quantity: 5n, priceOrOffset: price, expiresAt, clientOrderId: BigInt(100 + index * 2 + (side === "ask" ? 1 : 0)), postOnly: true,
      })], [maker]);
    }
  }
  await status();
} else if (stage === "status") {
  await status();
} else {
  throw new Error("usage: v3-e2e <seats|snapshot|fund|trade|take|close|restore|lookup|withdraw|quote|status>");
}
process.exit(0);
