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
import { DEFAULT_PROGRAM_ID } from "./deployment-manifest.mjs";
import { V3_LIFECYCLE_ORDER } from "./v3-lifecycle-readiness.mjs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(process.env.STOCKSTREAM_PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
const STATE_PATH = process.env.V3_LIFECYCLE_STATE_PATH ?? "/tmp/opencode/v3-lifecycle-state.json";
const DELEGATION_STATE_PATH = process.env.V3_DELEGATION_STATE_PATH ?? "/tmp/opencode/v3-delegation-state.json";
const SHARDED_COMMIT_STATE_PATH = process.env.V3_SHARDED_COMMIT_STATE_PATH ?? "/tmp/opencode/v3-sharded-commit-state.json";
const EXCHANGE_KEY_PATH = process.env.V3_EXCHANGE_KEY_PATH ?? "/tmp/opencode/v3-lifecycle-exchange.json";
const EXCHANGE_SEED = process.env.V3_EXCHANGE_SEED;
const INSTRUMENT_ID_HEX = process.env.V3_INSTRUMENT_ID_HEX;
const OLD_PROGRAM = "H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET";
const PRESERVED_AAPL_CORE = "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso";
const FRESH_AAPL_CORE = "7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei";
const PRESERVED_V2_MARKET = "9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS";
const SIZES = { core: 4_096, book: 10_184, seat: 8_236, event: 3_244, snapshot: 128 };
const BOOK_PAGES_PER_SIDE = 9;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PYTH_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
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
// Revision-1 accounts are permanently unsafe: their risk fields overlap the
// MagicBlock validator overlay. The previous program's only V3 accounts are
// revision 1, so never operate against it.
const PREVIOUS_REVISION1_PROGRAM = "Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ";
if (PROGRAM.toBase58() === PREVIOUS_REVISION1_PROGRAM) {
  throw new Error("refusing the revision-1 program; revision-2 markets require the corrected program ID");
}
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function send(name, ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  let lastError;
  // Public Devnet RPC rate-limits aggressively (429) and a stale blockhash
  // after retries shows up as BlockhashNotFound. Refresh the blockhash and
  // retry the whole simulate+send+confirm cycle instead of reusing one.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const simulation = await connection.simulateTransaction(tx, signers);
      if (simulation.value.err) {
        const logs = (simulation.value.logs ?? []).slice(-12).join(" | ");
        throw new Error(`${name}: simulation rejected ${JSON.stringify(simulation.value.err)}${logs ? `; logs: ${logs}` : ""}`);
      }
      console.log(`${name}: simulation ok units=${simulation.value.unitsConsumed ?? "unknown"}`);
      const signature = await connection.sendTransaction(tx, signers, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 });
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      const slot = await connection.getSlot("finalized");
      const state = load(); (state.events ??= []).push({ name, signature, slot, bytes: tx.serialize().length }); save(state);
      console.log(`${name}: ${signature} slot=${slot}`);
      await sleep(400);
      return { signature, slot };
    } catch (error) {
      lastError = error;
      const message = String(error?.transactionMessage ?? error?.message ?? error);
      console.log(`${name}: attempt ${attempt + 1}/6 failed (${message.slice(0, 140)}); retrying`);
      await sleep(600 * (attempt + 1));
    }
  }
  throw new Error(`${name}: ${String(lastError?.transactionMessage ?? lastError?.message ?? lastError)}`);
}
function ix(opcode, keys, data = []) { return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.from([opcode, ...data]) }); }
function updateInstrumentIx(exchange, instrument, payer, instrumentId) {
  const data = Buffer.alloc(41); instrumentId.copy(data, 0); data.writeUInt32LE(SELECTED_ORACLE.feedId, 32); data[36] = SELECTED_ORACLE.channel; data.writeInt32LE(SELECTED_ORACLE.exponent, 37);
  return new TransactionInstruction({ programId: PROGRAM, keys: [ro(exchange), wr(instrument), sg(payer.publicKey)], data: Buffer.concat([Buffer.from([22]), data]) });
}
// Canonical exchange-config encoding, mirroring
// `clients/stockstream/src/abi/exchange-config-instructions.ts`. This runner is
// plain ESM, so the bytes are written directly; every transaction is simulated
// before it is sent, so a malformed mask fails closed rather than landing.
const EXCHANGE_FIELD = {
  keeperAuthority: 1 << 2, makerFeeBps: 1 << 3, takerFeeBps: 1 << 4,
  liquidationFeeBps: 1 << 5, defaultInitialMarginBps: 1 << 6,
  defaultMaintenanceMarginBps: 1 << 7, defaultMaximumLeverage: 1 << 8,
  collateralMint: 1 << 9, oracleProgram: 1 << 10, protocolStatus: 1 << 12,
};
function updateExchangeConfigIx(exchange, authority, fields, expectedConfigSequence) {
  const data = Buffer.alloc(196); data[0] = 40;
  let mask = 0;
  const pubkey = (offset, bit, value) => { if (value === undefined) return; mask |= bit; value.toBuffer().copy(data, offset); };
  const u16 = (offset, bit, value) => { if (value === undefined) return; mask |= bit; data.writeUInt16LE(value, offset); };
  pubkey(69, EXCHANGE_FIELD.keeperAuthority, fields.keeperAuthority);
  u16(101, EXCHANGE_FIELD.makerFeeBps, fields.makerFeeBps);
  u16(103, EXCHANGE_FIELD.takerFeeBps, fields.takerFeeBps);
  u16(105, EXCHANGE_FIELD.liquidationFeeBps, fields.liquidationFeeBps);
  u16(107, EXCHANGE_FIELD.defaultInitialMarginBps, fields.defaultInitialMarginBps);
  u16(109, EXCHANGE_FIELD.defaultMaintenanceMarginBps, fields.defaultMaintenanceMarginBps);
  if (fields.defaultMaximumLeverage !== undefined) { mask |= EXCHANGE_FIELD.defaultMaximumLeverage; data.writeUInt32LE(fields.defaultMaximumLeverage, 111); }
  pubkey(115, EXCHANGE_FIELD.collateralMint, fields.collateralMint);
  pubkey(147, EXCHANGE_FIELD.oracleProgram, fields.oracleProgram);
  if (fields.protocolStatus !== undefined) { mask |= EXCHANGE_FIELD.protocolStatus; data[187] = fields.protocolStatus; }
  data.writeUInt32LE(mask, 1); data.writeBigUInt64LE(BigInt(expectedConfigSequence), 188);
  return new TransactionInstruction({ programId: PROGRAM, keys: [wr(exchange), sg(authority.publicKey)], data });
}
// Opcode 56: creates the V3 vault token account at ["vault", core]. The V2
// vault paths (opcodes 9/44) validate a 222,752-byte STKMRK01 header, so a
// 4,096-byte STKMK003 core can only get a vault through this instruction.
function createV3VaultAccountIx(core, vault, authority, mint) {
  return ix(56, [ro(core), wr(vault), wsg(authority.publicKey), ro(mint), ro(TOKEN_PROGRAM), ro(SystemProgram.programId)]);
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
function createOracleSnapshotIx(core, snapshot, payer) {
  return ix(59, [ro(core), wr(snapshot), wsg(payer.publicKey), ro(SystemProgram.programId)]);
}
async function ensureOracleSnapshot(core, payer) {
  const snapshot = PublicKey.findProgramAddressSync([Buffer.from("oracle-snapshot-v3"), core.toBuffer()], PROGRAM)[0];
  const existing = await connection.getAccountInfo(snapshot, "confirmed");
  if (existing) {
    if (!existing.owner.equals(PROGRAM) || existing.data.length !== SIZES.snapshot || existing.data.subarray(0, 8).toString() !== "STKORS03") throw new Error("oracle snapshot: existing account has wrong owner, size, or discriminator");
    return snapshot;
  }
  await send("create V3 oracle snapshot", [createOracleSnapshotIx(core, snapshot, payer)], [payer]);
  const created = await connection.getAccountInfo(snapshot, "confirmed");
  if (!created || !created.owner.equals(PROGRAM) || created.data.length !== SIZES.snapshot || created.data.subarray(0, 8).toString() !== "STKORS03") throw new Error("oracle snapshot: creation readback failed");
  return snapshot;
}
const V3_DISCRIMINATORS = { core: "STKMK003", book: "STKBK003", seat: "STKST003", event: "STKEV003" };
async function verifyBundle(core, accounts) {
  const coreInfo = await connection.getAccountInfo(core, "confirmed");
  if (!coreInfo || !coreInfo.owner.equals(PROGRAM) || coreInfo.data.length !== SIZES.core) throw new Error("bundle: core missing, foreign-owned, or wrong-sized");
  if (coreInfo.data.subarray(0, 8).toString() !== V3_DISCRIMINATORS.core || coreInfo.data.readUInt16LE(8) !== 3 || coreInfo.data[10] !== 1) throw new Error("bundle: core discriminator/version/initialized invalid");
  if (coreInfo.data[371] !== 2) throw new Error("bundle: core is not revision 2; refusing the revision-1 risk layout");
  if (coreInfo.data.readUInt32LE(246) !== SELECTED_ORACLE.feedId || coreInfo.data[250] !== SELECTED_ORACLE.channel || coreInfo.data.readInt32LE(251) !== SELECTED_ORACLE.exponent) throw new Error("bundle: core oracle metadata does not match the configured instrument");
  const expected = [
    ...accounts.bookPages.map((key) => [key, V3_DISCRIMINATORS.book, SIZES.book]),
    ...accounts.seatShards.map((key) => [key, V3_DISCRIMINATORS.seat, SIZES.seat]),
    ...accounts.eventShards.map((key) => [key, V3_DISCRIMINATORS.event, SIZES.event]),
  ];
  const all = [core.toBase58(), ...expected.map(([key]) => key)];
  if (all.length !== 27 || new Set(all).size !== 27) throw new Error("bundle: incomplete or aliased account set");
  const infos = await connection.getMultipleAccountsInfo(expected.map(([key]) => new PublicKey(key)), "confirmed");
  for (let index = 0; index < expected.length; index += 1) {
    const [key, discriminator, size] = expected[index];
    const info = infos[index];
    if (!info || !info.owner.equals(PROGRAM) || info.data.length !== size) throw new Error(`bundle: ${key} missing, foreign-owned, or wrong-sized`);
    if (info.data.subarray(0, 8).toString() !== discriminator || info.data.readUInt16LE(8) !== 3) throw new Error(`bundle: ${key} discriminator/version invalid`);
  }
  return { accountCount: all.length, coreRevision: 2, allOwnedByProgram: true };
}
async function setup() {
  if (!execute) throw new Error("add --execute to submit Devnet transactions");
  const state = load(); assertFresh(state);
  const payer = authority();
  let exchangePublicKey; let exchangeCreateInstruction; let exchangeCreateSigners;
  if (EXCHANGE_SEED) {
    if (Buffer.byteLength(EXCHANGE_SEED, "utf8") > 32) throw new Error("V3_EXCHANGE_SEED must be at most 32 bytes");
    exchangePublicKey = await PublicKey.createWithSeed(payer.publicKey, EXCHANGE_SEED, PROGRAM);
    const lamports = await connection.getMinimumBalanceForRentExemption(256);
    exchangeCreateInstruction = SystemProgram.createAccountWithSeed({ fromPubkey: payer.publicKey, newAccountPubkey: exchangePublicKey, basePubkey: payer.publicKey, seed: EXCHANGE_SEED, lamports, space: 256, programId: PROGRAM });
    exchangeCreateSigners = [payer];
  } else {
    const exchange = exchangeKeypair(); exchangePublicKey = exchange.publicKey;
    const lamports = await connection.getMinimumBalanceForRentExemption(256);
    exchangeCreateInstruction = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: exchange.publicKey, lamports, space: 256, programId: PROGRAM });
    exchangeCreateSigners = [payer, exchange];
  }
  let instrumentId = state.instrumentId ? Buffer.from(state.instrumentId) : null;
  if (!instrumentId) {
    if (INSTRUMENT_ID_HEX && !/^[0-9a-fA-F]{64}$/.test(INSTRUMENT_ID_HEX)) throw new Error("V3_INSTRUMENT_ID_HEX must contain exactly 32 bytes");
    instrumentId = INSTRUMENT_ID_HEX ? Buffer.from(INSTRUMENT_ID_HEX, "hex") : Buffer.alloc(32);
    if (!INSTRUMENT_ID_HEX) Buffer.from(`V3-${Date.now()}`).copy(instrumentId);
    save({ version: 3, instrumentId: [...instrumentId] });
  }
  const instrument = PublicKey.findProgramAddressSync([Buffer.from("instrument"), instrumentId], PROGRAM)[0];
  const core = PublicKey.findProgramAddressSync([Buffer.from("market-v3"), instrument.toBuffer()], PROGRAM)[0];
  if (core.toBase58() === PRESERVED_V2_MARKET) throw new Error("refusing preserved V2 market");
  if (!state.exchangeCreated) {
    await send("create V3 exchange", [exchangeCreateInstruction], exchangeCreateSigners);
    save({ exchangeCreated: true, exchange: exchangePublicKey.toBase58() });
  }
  if (!(await connection.getAccountInfo(instrument, "confirmed"))) await send("create V3 instrument", [ix(43, [wr(instrument), wsg(payer.publicKey), ro(SystemProgram.programId)], [...instrumentId])], [payer]);
  const exchangeInfo = await connection.getAccountInfo(exchangePublicKey, "confirmed");
  if (!exchangeInfo?.data[10]) await send("initialize V3 exchange", [ix(19, [wr(exchangePublicKey), sg(payer.publicKey)])], [payer]);
  // Collateral mint + exchange configuration MUST precede core activation:
  // `initialize_v3_market` copies the exchange's collateral mint into the core,
  // and a zero mint makes every V3 custody path impossible.
  let mint = state.mint
    ? new PublicKey(state.mint)
    : process.env.V3_COLLATERAL_MINT
      ? new PublicKey(process.env.V3_COLLATERAL_MINT)
      : null;
  if (!mint) {
    mint = await createMint(connection, payer, payer.publicKey, null, 6);
    console.log(`created test collateral mint: ${mint.toBase58()}`);
  }
  save({ mint: mint.toBase58() });
  const exchangeAccount = await connection.getAccountInfo(exchangePublicKey, "confirmed");
  if (!new PublicKey(exchangeAccount.data.subarray(157, 189)).equals(mint)) {
    await send("configure V3 exchange", [updateExchangeConfigIx(exchangePublicKey, payer, {
      collateralMint: mint, keeperAuthority: payer.publicKey, oracleProgram: PYTH_PROGRAM,
      makerFeeBps: 0, takerFeeBps: 5, liquidationFeeBps: 50,
      defaultInitialMarginBps: 2_000, defaultMaintenanceMarginBps: 1_000, defaultMaximumLeverage: 5,
      protocolStatus: 0,
    }, exchangeAccount.data.readBigUInt64LE(230))], [payer]);
  }
  const instrumentInfo = await connection.getAccountInfo(instrument, "confirmed");
  if (!instrumentInfo?.data[10]) await send("register V3 instrument", [ix(20, [ro(exchangePublicKey), wr(instrument), sg(payer.publicKey)], [...instrumentId])], [payer]);
  const configuredInstrument = await connection.getAccountInfo(instrument, "confirmed");
  const metadata = instrumentMetadata(configuredInstrument);
  const isUnset = metadata.feedId === 0 && metadata.channel === 0 && metadata.exponent === 0;
  const matchesSelectedOracle = metadata.feedId === SELECTED_ORACLE.feedId && metadata.channel === SELECTED_ORACLE.channel && metadata.exponent === SELECTED_ORACLE.exponent;
  if (isUnset) await send("configure V3 instrument oracle", [updateInstrumentIx(exchangePublicKey, instrument, payer, instrumentId)], [payer]);
  else if (!matchesSelectedOracle) throw new Error(`instrument oracle metadata conflict: ${JSON.stringify(metadata)}`);
  await ensureV3Account("V3 core", instrument, core, 0, 0, SIZES.core, payer);
  const coreInfo = await connection.getAccountInfo(core, "confirmed");
  if (coreInfo?.data?.length >= 108
      && coreInfo.data[11] !== 0
      && coreInfo.data.subarray(76, 108).every((byte) => byte === 0)) {
    throw new Error(`refusing activated zero-mint core ${core.toBase58()}; create a fresh market`);
  }
  if (!coreInfo?.data[11]) {
    try {
      await send("activate V3 core", [ix(47, [ro(exchangePublicKey), ro(instrument), wr(core), sg(payer.publicKey), ro(mint)])], [payer]);
      save({ activationBlocked: null, activationComplete: true });
    } catch (error) {
      if (!String(error?.transactionMessage ?? error).includes("0x6004")) throw error;
      save({ activationBlocked: "oracle_unavailable" });
      console.log("activate V3 core: blocked by OracleUnavailable (0x6004); continuing account bootstrap without activation");
    }
  }
  // V3 vault: required by opcode 53 deposit. Created after activation because
  // the handler validates an activated revision-2 core.
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), core.toBuffer()], PROGRAM)[0];
  if (!(await connection.getAccountInfo(vault, "confirmed"))) {
    const activated = await connection.getAccountInfo(core, "confirmed");
    if (!activated?.data[11]) throw new Error("V3 vault requires an activated core; activation was blocked");
    await send("create V3 vault", [createV3VaultAccountIx(core, vault, payer, mint)], [payer]);
  }
  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  if (!vaultInfo || !vaultInfo.owner.equals(TOKEN_PROGRAM) || vaultInfo.data.length !== 165) throw new Error("vault: missing, foreign-owned, or malformed");
  save({ vault: vault.toBase58() });
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
  const snapshot = await ensureOracleSnapshot(core, payer);
  save({ version: 3, core: core.toBase58(), instrument: instrument.toBase58(), oracleSnapshot: snapshot.toBase58(), v3Accounts: accounts });
  const bundle = await verifyBundle(core, accounts);
  const activatedCore = await connection.getAccountInfo(core, "confirmed");
  if (!new PublicKey(activatedCore.data.subarray(76, 108)).equals(mint)) throw new Error("core collateral mint does not match the configured exchange mint");
  save({ setupComplete: true, bundleVerified: bundle });
  console.log(JSON.stringify({ statePath: STATE_PATH, core: core.toBase58(), vault: vault.toBase58(), mint: mint.toBase58(), accounts, bundle }, null, 2));
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
    requiredOrder: V3_LIFECYCLE_ORDER,
    stages: {
      setup: setupComplete ? "complete: fresh core + 18 pages + 4 seat shards + 4 event shards" : "pending: run --execute setup (existing accounts are resumed, never recreated)",
      delegation: delegated ? "complete: checkpoint proves all 27 accounts delegated" : "pending: delegation checkpoint is absent or incomplete",
      commit: committed ? "complete: sharded commit checkpoint finalized" : "blocked/pending: commit checkpoint incomplete; full 27-account intent remains rejected with Magic error 0xa0000002",
      undelegation: committed ? "available: node scripts/v3-sharded-commit.mjs undelegate; restore still depends on external callback" : "blocked: commit/finality checkpoint required before undelegation",
      custody: "L1 seat + op53 test deposit + collateral readback required BEFORE delegation; op54 withdrawal requires restore/reconciliation",
      trading: "source handlers exist for place/cancel/cancel-all and main-wallet replace; live blocked until oracle/session-replace completion",
    }, state,
  }, null, 2));
}
if (stage === "plan") plan(); else if (stage === "setup") await setup(); else throw new Error("usage: node scripts/v3-devnet-lifecycle.mjs [--execute] [plan|setup]");
