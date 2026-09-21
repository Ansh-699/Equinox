#!/usr/bin/env node
/**
 * Fresh, resumable V3 Devnet bootstrap. This intentionally has a separate
 * checkpoint from `devnet-lifecycle.mjs` and refuses the preserved V2 market.
 * It creates/activates only V3 state supported by the deployed program ABI.
 * Custody uses explicit V3 opcodes 53/54, but execution remains opt-in after
 * a restored/reconciled checkpoint; this runner never treats a pending
 * MagicBlock callback as a completed withdrawal.
 *
 * `node scripts/v3-devnet-lifecycle.mjs plan` is read-only.
 * `node scripts/v3-devnet-lifecycle.mjs --execute setup` sends Devnet txs.
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(process.env.STOCKSTREAM_PROGRAM_ID ?? "Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ");
const STATE_PATH = process.env.V3_LIFECYCLE_STATE_PATH ?? "/tmp/opencode/v3-lifecycle-state.json";
const DELEGATION_STATE_PATH = process.env.V3_DELEGATION_STATE_PATH ?? "/tmp/opencode/v3-delegation-state.json";
const SHARDED_COMMIT_STATE_PATH = process.env.V3_SHARDED_COMMIT_STATE_PATH ?? "/tmp/opencode/v3-sharded-commit-state.json";
const EXCHANGE_KEY_PATH = process.env.V3_EXCHANGE_KEY_PATH ?? "/tmp/opencode/v3-lifecycle-exchange.json";
const OLD_PROGRAM = "H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET";
const PRESERVED_AAPL_CORE = "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso";
const FRESH_AAPL_CORE = "7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei";
const PRESERVED_V2_MARKET = "9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS";
const SIZES = { core: 4_096, book: 10_184, seat: 8_236, event: 3_244 };
const BOOK_PAGES_PER_SIDE = 9;
const ORACLE_CHANNELS = new Map([
  ["real_time", 1],
  ["fixed_rate@50ms", 2],
  ["fixed_rate@200ms", 3],
  ["fixed_rate@1000ms", 4],
]);
function selectedOracle() {
  const feedId = Number(process.env.V3_ORACLE_FEED_ID ?? 922);
  const channelName = process.env.V3_ORACLE_CHANNEL ?? "fixed_rate@50ms";
  const channel = ORACLE_CHANNELS.get(channelName);
  const exponent = Number(process.env.V3_ORACLE_EXPONENT ?? -5);
  const symbol = process.env.V3_ORACLE_SYMBOL ?? "Equity.US.AAPL/USD";
  if (!Number.isSafeInteger(feedId) || feedId <= 0) throw new Error("V3_ORACLE_FEED_ID must be a positive integer");
  if (channel === undefined) throw new Error("V3_ORACLE_CHANNEL must be a documented Pyth Pro channel");
  if (!Number.isSafeInteger(exponent) || exponent < -12 || exponent > 0) throw new Error("V3_ORACLE_EXPONENT must be an integer between -12 and 0");
  return { feedId, channel, channelName, exponent, symbol };
}
const SELECTED_ORACLE = selectedOracle();
const connection = new Connection(RPC, "confirmed");
const execute = process.argv.includes("--execute");
const stage = process.argv.filter((value) => !value.startsWith("--")).at(-1) ?? "plan";

const load = () => fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : {};
function save(patch) { fs.writeFileSync(STATE_PATH, JSON.stringify({ ...load(), ...patch }, null, 2)); fs.chmodSync(STATE_PATH, 0o600); }
const ro = (key) => ({ pubkey: new PublicKey(key), isSigner: false, isWritable: false });
const wr = (key) => ({ pubkey: new PublicKey(key), isSigner: false, isWritable: true });
const sg = (key) => ({ pubkey: new PublicKey(key), isSigner: true, isWritable: false });
const wsg = (key) => ({ pubkey: new PublicKey(key), isSigner: true, isWritable: true });

function authority() {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
}
function exchangeKeypair() {
  if (fs.existsSync(EXCHANGE_KEY_PATH)) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(EXCHANGE_KEY_PATH, "utf8"))));
  const keypair = Keypair.generate();
  fs.writeFileSync(EXCHANGE_KEY_PATH, JSON.stringify([...keypair.secretKey])); fs.chmodSync(EXCHANGE_KEY_PATH, 0o600);
  return keypair;
}
function assertFresh(state) {
  if (PROGRAM.toBase58() === OLD_PROGRAM) throw new Error("refusing old StockStream program");
  if ([PRESERVED_AAPL_CORE, FRESH_AAPL_CORE, PRESERVED_V2_MARKET].includes(state.market)
    || [PRESERVED_AAPL_CORE, FRESH_AAPL_CORE, PRESERVED_V2_MARKET].includes(state.core)) {
    throw new Error("refusing preserved AAPL/V2 market or core");
  }
  if (state.version !== undefined && state.version !== 3) throw new Error("checkpoint is not V3");
}
async function send(name, ixs, signers) {
  const tx = new Transaction().add(...ixs);
  const simulation = await connection.simulateTransaction(tx, signers);
  if (simulation.value.err) {
    const logs = (simulation.value.logs ?? []).slice(-12).join(" | ");
    throw new Error(`${name}: simulation rejected ${JSON.stringify(simulation.value.err)}${logs ? `; logs: ${logs}` : ""}`);
  }
  console.log(`${name}: simulation ok units=${simulation.value.unitsConsumed ?? "unknown"}`);
  const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  const slot = await connection.getSlot("finalized");
  const state = load(); (state.events ??= []).push({ name, signature, slot, bytes: tx.serialize().length }); save(state);
  console.log(`${name}: ${signature} slot=${slot}`); return { signature, slot };
}
function ix(opcode, keys, data = []) { return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.from([opcode, ...data]) }); }
function updateInstrumentIx(exchange, instrument, payer, instrumentId) {
  const data = Buffer.alloc(41); instrumentId.copy(data, 0); data.writeUInt32LE(SELECTED_ORACLE.feedId, 32); data[36] = SELECTED_ORACLE.channel; data.writeInt32LE(SELECTED_ORACLE.exponent, 37);
  return new TransactionInstruction({ programId: PROGRAM, keys: [ro(exchange), wr(instrument), sg(payer.publicKey)], data: Buffer.concat([Buffer.from([22]), data]) });
}
function instrumentMetadata(info) {
  if (!info || info.data.length !== 128) throw new Error("fresh instrument account has an unexpected layout");
  return { feedId: info.data.readUInt32LE(75), channel: info.data[79], exponent: info.data.readInt32LE(107) };
}
async function ensureV3Account(label, parent, target, kind, index, size, payer) {
  for (;;) {
    const existing = await connection.getAccountInfo(target, "confirmed");
    if (existing?.owner.equals(PROGRAM) && existing.data.length === size) return;
    if (existing?.owner.equals(PROGRAM)) throw new Error(`${label}: existing StockStream account has size ${existing.data.length}, expected ${size}; refusing to recreate or overwrite it`);
    if (existing && !existing.owner.equals(SystemProgram.programId) && !existing.owner.equals(PROGRAM)) throw new Error(`${label}: target occupied by foreign owner`);
    await send(`${label} create/resume`, [ix(46, [ro(parent), wr(target), wsg(payer.publicKey), ro(SystemProgram.programId)], [kind, index])], [payer]);
  }
}
async function setup() {
  if (!execute) throw new Error("add --execute to submit Devnet transactions");
  const state = load(); assertFresh(state);
  const payer = authority(); const exchange = exchangeKeypair();
  let instrumentId = state.instrumentId ? Buffer.from(state.instrumentId) : null;
  if (!instrumentId) { instrumentId = Buffer.alloc(32); Buffer.from(`V3-${Date.now()}`).copy(instrumentId); save({ version: 3, instrumentId: [...instrumentId] }); }
  const instrument = PublicKey.findProgramAddressSync([Buffer.from("instrument"), instrumentId], PROGRAM)[0];
  const core = PublicKey.findProgramAddressSync([Buffer.from("market-v3"), instrument.toBuffer()], PROGRAM)[0];
  if (core.toBase58() === PRESERVED_V2_MARKET) throw new Error("refusing preserved V2 market");
  if (!state.exchangeCreated) {
    const lamports = await connection.getMinimumBalanceForRentExemption(256);
    await send("create V3 exchange", [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: exchange.publicKey, lamports, space: 256, programId: PROGRAM })], [payer, exchange]);
    save({ exchangeCreated: true, exchange: exchange.publicKey.toBase58() });
  }
  if (!(await connection.getAccountInfo(instrument, "confirmed"))) await send("create V3 instrument", [ix(43, [wr(instrument), wsg(payer.publicKey), ro(SystemProgram.programId)], [...instrumentId])], [payer]);
  const exchangeInfo = await connection.getAccountInfo(exchange.publicKey, "confirmed");
  if (!exchangeInfo?.data[10]) await send("initialize V3 exchange", [ix(19, [wr(exchange.publicKey), sg(payer.publicKey)])], [payer]);
  const instrumentInfo = await connection.getAccountInfo(instrument, "confirmed");
  if (!instrumentInfo?.data[10]) await send("register V3 instrument", [ix(20, [ro(exchange.publicKey), wr(instrument), sg(payer.publicKey)], [...instrumentId])], [payer]);
  const configuredInstrument = await connection.getAccountInfo(instrument, "confirmed");
  const metadata = instrumentMetadata(configuredInstrument);
  const isUnset = metadata.feedId === 0 && metadata.channel === 0 && metadata.exponent === 0;
  const matchesSelectedOracle = metadata.feedId === SELECTED_ORACLE.feedId && metadata.channel === SELECTED_ORACLE.channel && metadata.exponent === SELECTED_ORACLE.exponent;
  if (isUnset) await send("configure V3 instrument oracle", [updateInstrumentIx(exchange.publicKey, instrument, payer, instrumentId)], [payer]);
  else if (!matchesSelectedOracle) throw new Error(`instrument oracle metadata conflict: ${JSON.stringify(metadata)}`);
  await ensureV3Account("V3 core", instrument, core, 0, 0, SIZES.core, payer);
  const coreInfo = await connection.getAccountInfo(core, "confirmed");
  if (!coreInfo?.data[11]) {
    try {
      await send("activate V3 core", [ix(47, [ro(exchange.publicKey), ro(instrument), wr(core), sg(payer.publicKey)])], [payer]);
      save({ activationBlocked: null, activationComplete: true });
    } catch (error) {
      if (!String(error?.transactionMessage ?? error).includes("0x6004")) throw error;
      save({ activationBlocked: "oracle_unavailable" });
      console.log("activate V3 core: blocked by OracleUnavailable (0x6004); continuing account bootstrap without activation");
    }
  }
  const accounts = { bookPages: [], seatShards: [], eventShards: [] };
  for (let side = 0; side < 2; side += 1) for (let page = 0; page < BOOK_PAGES_PER_SIDE; page += 1) {
    const index = side * BOOK_PAGES_PER_SIDE + page; const target = PublicKey.findProgramAddressSync([Buffer.from("book-page-v3"), core.toBuffer(), Buffer.from([side]), Buffer.from([page])], PROGRAM)[0];
    await ensureV3Account(`V3 book ${side}/${page}`, core, target, 1, index, SIZES.book, payer); accounts.bookPages.push(target.toBase58());
  }
  for (let index = 0; index < 4; index += 1) {
    const seat = PublicKey.findProgramAddressSync([Buffer.from("seat-shard-v3"), core.toBuffer(), Buffer.from([index])], PROGRAM)[0];
    const event = PublicKey.findProgramAddressSync([Buffer.from("event-shard-v3"), core.toBuffer(), Buffer.from([index])], PROGRAM)[0];
    await ensureV3Account(`V3 seat shard ${index}`, core, seat, 2, index, SIZES.seat, payer);
    await ensureV3Account(`V3 event shard ${index}`, core, event, 3, index, SIZES.event, payer);
    accounts.seatShards.push(seat.toBase58()); accounts.eventShards.push(event.toBase58());
  }
  save({ version: 3, core: core.toBase58(), instrument: instrument.toBase58(), v3Accounts: accounts, setupComplete: true });
  console.log(JSON.stringify({ statePath: STATE_PATH, core: core.toBase58(), accounts }, null, 2));
}
function plan() {
  const state = load(); assertFresh(state);
  const readCheckpoint = (path) => {
    try { return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null; } catch { return null; }
  };
  const delegation = readCheckpoint(DELEGATION_STATE_PATH);
  const commit = readCheckpoint(SHARDED_COMMIT_STATE_PATH);
  const setupComplete = state.setupComplete === true
    && state.core && state.v3Accounts
    && state.v3Accounts.bookPages?.length === 18
    && state.v3Accounts.seatShards?.length === 4
    && state.v3Accounts.eventShards?.length === 4;
  const delegated = delegation?.complete === true || state.delegationComplete === true;
  const committed = commit?.complete === true;
  console.log(JSON.stringify({
    version: 3, execute, statePath: STATE_PATH,
    protectedAccounts: [PRESERVED_AAPL_CORE, FRESH_AAPL_CORE, PRESERVED_V2_MARKET],
    oracle: SELECTED_ORACLE,
    stages: {
      setup: setupComplete ? "complete: fresh core + 18 pages + 4 seat shards + 4 event shards" : "pending: run --execute setup (existing accounts are resumed, never recreated)",
      delegation: delegated ? "complete: checkpoint proves all 27 accounts delegated" : "pending: delegation checkpoint is absent or incomplete",
      commit: committed ? "complete: sharded commit checkpoint finalized" : "blocked/pending: commit checkpoint incomplete; full 27-account intent remains rejected with Magic error 0xa0000002",
      undelegation: committed ? "available: node scripts/v3-sharded-commit.mjs undelegate; restore still depends on external callback" : "blocked: commit/finality checkpoint required before undelegation",
      custody: "source complete: op53 deposit and op54 full-bundle restored/reconciled flat-seat withdrawal; live submit waits for restore",
      trading: "source handlers exist for place/cancel/cancel-all and main-wallet replace; live blocked until oracle/session-replace completion",
    }, state,
  }, null, 2));
}
if (stage === "plan") plan(); else if (stage === "setup") await setup(); else throw new Error("usage: node scripts/v3-devnet-lifecycle.mjs [--execute] [plan|setup]");
