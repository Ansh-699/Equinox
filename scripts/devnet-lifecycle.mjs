#!/usr/bin/env node
/**
 * Bounded Equinox MagicBlock Devnet lifecycle.
 * Resumable stages (checkpoint state in /tmp/opencode/lifecycle-state.json).
 * Never prints secret bytes.
 */
import fs from "node:fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint,
} from "@solana/spl-token";

const RPC = "https://api.devnet.solana.com";
const ROUTER = "https://devnet-router.magicblock.app";
const CONNECTION = new Connection(RPC, "confirmed");
const STATE_PATH = "/tmp/opencode/lifecycle-state.json";
const PROGRAM_ID = new PublicKey(process.env.EQUINOX_PROGRAM_ID ?? "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const MARKET_SIZE = 222_752;
const SCRATCH_SIZE = 12_288;
const DEPOSIT = 400_000;

const authority = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))),
);
const traderB = traderKeypair("traderB");

function traderKeypair(name) {
  const path = `/tmp/opencode/lifecycle-${name}.json`;
  if (fs.existsSync(path)) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const load = () => fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH)) : {};
function save(patch) { fs.writeFileSync(STATE_PATH, JSON.stringify({ ...load(), ...patch }, null, 2)); }
const must = (s, f) => { if (s[f] === undefined) throw new Error(`state.${f} missing; run the previous stage`); return s[f]; };
const pk = (v) => new PublicKey(v);
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const ro = (k) => ({ pubkey: pk(k), isSigner: false, isWritable: false });
const wr = (k) => ({ pubkey: pk(k), isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: pk(k), isSigner: true, isWritable: false });
const wsg = (k) => ({ pubkey: pk(k), isSigner: true, isWritable: true });

async function send(name, ixs, signers, opts = {}) {
  const t0 = Date.now();
  const tx = new Transaction();
  tx.add(...ixs);
  const signature = await sendAndConfirmTransaction(CONNECTION, tx, signers, {
    commitment: "confirmed", skipPreflight: opts.skipPreflight ?? false,
  });
  const slot = await CONNECTION.getSlot("finalized");
  const ms = Date.now() - t0;
  const state = load();
  (state.events ||= []).push({ name, signature, slot, ms, wireBytes: tx.serialize().length });
  save(state);
  console.log(`${name}: sig=${signature.slice(0, 20)}… slot=${slot} ms=${ms} bytes=${tx.serialize().length}`);
  return { signature, slot, ms };
}

async function stageSetup() {
  const state = load();
  if (state.market) { log("market exists:", state.market); return; }
  const instrumentId = Buffer.alloc(32, 0);
  Buffer.from(`LIFECYCLE-${Date.now()}`, "latin1").copy(instrumentId);

  const exchange = Keypair.generate();
  const instrumentPda = PublicKey.findProgramAddressSync(
    [Buffer.from("instrument"), instrumentId], PROGRAM_ID)[0];
  const marketPda = PublicKey.findProgramAddressSync(
    [Buffer.from("perp-market"), instrumentPda.toBuffer()], PROGRAM_ID)[0];
  const exchangeLamports = await CONNECTION.getMinimumBalanceForRentExemption(256);

  await send("create exchange", [SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: exchange.publicKey, lamports: exchangeLamports, space: 256, programId: PROGRAM_ID })], [authority, exchange]);

  await send("create instrument (op43)", [new TransactionInstruction({
    programId: PROGRAM_ID, keys: [wr(instrumentPda), wsg(authority.publicKey), ro(SystemProgram.programId)],
    data: Buffer.from([43, ...instrumentId]),
  })], [authority]);

  // Market PDA: opcode 42 grows incrementally (10,240B per inner-instruction cap)
  const createStep = () => new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [ro(instrumentPda), wr(marketPda), wsg(authority.publicKey), ro(SystemProgram.programId)],
    data: Buffer.from([42]),
  });
  await send("market first chunk", [createStep()], [authority]);
  for (;;) {
    const info = await CONNECTION.getAccountInfo(marketPda, "confirmed");
    if (info && info.data.length === MARKET_SIZE) break;
    await send(`grow market (${info ? info.data.length : 0}/${MARKET_SIZE})`, [createStep()], [authority]);
    await new Promise(r => setTimeout(r, 1500));
  }

  await send("init exchange", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [wr(exchange.publicKey), sg(authority.publicKey)], data: Buffer.from([19]) })], [authority]);
  await send("register instrument", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [ro(exchange.publicKey), wr(instrumentPda), sg(authority.publicKey)], data: Buffer.from([20, ...instrumentId]) })], [authority]);
  await send("update instrument", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [ro(exchange.publicKey), wr(instrumentPda), sg(authority.publicKey)], data: Buffer.from([22, ...instrumentId, 33, 0, 0, 0, 1, 0xfa, 0xff, 0xff, 0xff]) })], [authority]);
  await send("create perp market", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [ro(instrumentPda), wr(marketPda), sg(authority.publicKey)], data: Buffer.from([21, ...instrumentId]) })], [authority]);

  const info = await CONNECTION.getAccountInfo(marketPda, "confirmed");
  if (!info || !info.data.readUInt8(10)) throw new Error("market not initialized");
  save({ instrumentId: [...instrumentId], exchange: exchange.publicKey.toBase58(), instrument: instrumentPda.toBase58(), market: marketPda.toBase58() });
  log("MARKET =", marketPda.toBase58());
}

async function stageCustody() {
  const state = load();
  const market = pk(must(state, "market"));
  let mint = state.mint ? pk(state.mint) : null;
  if (!mint) {
    mint = await createMint(CONNECTION, authority, authority.publicKey, null, 6);
    save({ mint: mint.toBase58() });
    log("MINT =", mint.toBase58());
  }
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];

  if (!state.vaultInitialized) {
    const vaultInfo = await CONNECTION.getAccountInfo(vault);
    if (!vaultInfo) {
      // 6 accounts, not 7: the vault authority PDA is derived on-chain by
      // the handler itself (registry.rs::create_vault_account), never a
      // caller-supplied account. token_program IS still required (a CPI's
      // target program must be one of the calling instruction's own
      // accounts), just no longer left unvalidated.
      await send("create vault (op44)", [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), wr(vault), wsg(authority.publicKey), ro(mint), ro(TOKEN_PROGRAM), ro(SystemProgram.programId)],
        data: Buffer.from([44]),
      })], [authority]);
    }
    save({ vaultInitialized: true });
  }

  // Every non-authority trader keypair (traderB) is freshly generated
  // locally (see traderKeypair()) with zero SOL -- it cannot pay for its
  // own seat/ATA/deposit transaction fees until funded. A devnet airdrop
  // is rate-limited and unreliable, so fund it from the already-funded
  // authority wallet directly instead.
  const MIN_TRADER_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
  for (const trader of [traderB]) {
    const balance = await CONNECTION.getBalance(trader.publicKey);
    if (balance < MIN_TRADER_LAMPORTS) {
      await send(`fund ${trader.publicKey.toBase58().slice(0, 8)}`, [
        SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: trader.publicKey, lamports: MIN_TRADER_LAMPORTS }),
      ], [authority]);
    }
  }

  for (const [trader, seat] of [[authority, 0], [traderB, 1]]) {
    await send(`seat ${seat}`, [new TransactionInstruction({ programId: PROGRAM_ID, keys: [wr(market), sg(trader.publicKey)], data: Buffer.from([1, seat, 0]) })], [trader]).catch((e) => console.log(`seat ${seat}: ${String(e).slice(0, 90)}`));
    const ata = await getOrCreateAssociatedTokenAccount(CONNECTION, trader, mint, trader.publicKey);
    const bal = Number((await getAccount(CONNECTION, ata.address)).amount);
    if (bal < 1_000_000) {
      await send(`mint to trader ${seat}`, [
        (() => { const d = Buffer.alloc(9); d[0] = 7; d.writeBigUInt64LE(1_000_000n, 1); return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [wr(mint), wr(ata.address), sg(authority.publicKey)], data: d }); })(),
      ], [authority]);
    }
    const deposited = seat === 0 ? state.depositedA : state.depositedB;
    if (!deposited) {
      // 6 accounts, not 7: the seat lives inside the market account itself,
      // so there is no separate "seat slot" account to create or pass here
      // (handlers.rs::deposit_collateral).
      await send(`deposit ${seat}`, [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), sg(trader.publicKey), wr(ata.address), wr(vault), ro(mint), ro(TOKEN_PROGRAM)],
        data: (() => { const d = Buffer.alloc(11); d[0] = 10; d.writeUInt16LE(seat, 1); d.writeBigUInt64LE(BigInt(DEPOSIT), 3); return d; })(),
      })], [trader]);
      save(seat === 0 ? { depositedA: DEPOSIT } : { depositedB: DEPOSIT });
    }
  }
  const m = await getMint(CONNECTION, mint);
  log(`mint supply=${m.supply} vault=${(await getAccount(CONNECTION, vault)).amount}`);
}

async function stageSessions() {
  const state = load();
  const market = pk(must(state, "market"));
  for (const [trader, seat, name] of [[authority, 0, "A"], [traderB, 1, "B"]]) {
    const scratch = PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0])], PROGRAM_ID)[0];
    if (!(await CONNECTION.getAccountInfo(scratch))) {
      // Opcode 45: the program CPI-creates AND initializes the scratch PDA
      // in one atomic instruction (a PDA cannot sign a top-level
      // SystemProgram::createAccount, only invoke_signed from inside the
      // owning program) -- registry.rs::create_scratch_account's real
      // account order is [market(w), trader(signer), scratch(w),
      // payer(signer,w), system_program]. There is no separate opcode-8
      // "initialize" step to run afterward: this instruction already
      // leaves the scratch account fully initialized.
      await send(`create scratch ${seat}`, [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), sg(trader.publicKey), wr(scratch), wsg(authority.publicKey), ro(SystemProgram.programId)],
        data: Buffer.from([45, seat, 0]),
      })], [trader, authority]);
    }
    const sessionSigner = traderKeypair(`sessionSigner${name}`);
    const sessionPda = PublicKey.findProgramAddressSync([
      Buffer.from("trading_session"), trader.publicKey.toBuffer(), market.toBuffer(), Buffer.from([seat, 0]), sessionSigner.publicKey.toBuffer(),
    ], PROGRAM_ID)[0];
    if (!(await CONNECTION.getAccountInfo(sessionPda))) {
      const data = Buffer.alloc(46);
      data[0] = 17; data.writeUInt16LE(seat, 1);
      data.writeBigUInt64LE(BigInt(Date.now() + 6 * 3_600_000), 3);
      data[11] = 0b11111;
      data.writeBigUInt64LE(2_000_000n, 12);
      data.writeBigUInt64LE(10_000_000n, 20);
      data.writeBigInt64LE(5_000_000n, 28);
      data.writeUInt16LE(32, 44);
      await send(`authorize session ${name}`, [new TransactionInstruction({
        programId: PROGRAM_ID, keys: [wr(market), wsg(trader.publicKey), wr(sessionPda), ro(sessionSigner.publicKey), ro(SystemProgram.programId)], data,
      })], [trader]);
      save({ [`session${name}`]: sessionPda.toBase58(), [`sessionSigner${name}`]: sessionSigner.publicKey.toBase58() });
    } else { log(`session ${name} exists`); }
  }
}

async function stageDelegate() {
  const state = load();
  const market = pk(must(state, "market"));
  const instrument = pk(must(state, "instrument"));
  if (state.delegated) { log("already delegated"); return; }
  const buffer = PublicKey.findProgramAddressSync([Buffer.from("buffer"), market.toBuffer()], PROGRAM_ID)[0];
  const record = PublicKey.findProgramAddressSync([Buffer.from("delegation"), market.toBuffer()], DELEGATION_PROGRAM)[0];
  const metadata = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), market.toBuffer()], DELEGATION_PROGRAM)[0];

  // `delegated` is the completion marker for the WHOLE 5-account hot
  // cluster (market + 2 scratch + 2 sessions) -- it must only be saved
  // after every member below has ALSO been delegated, never right after
  // the market alone, or a crash mid-loop would make a resume believe an
  // incompletely-delegated cluster was done and skip it entirely.
  // `marketDelegated` is the narrower, separate checkpoint that lets a
  // resume skip re-delegating the market specifically (which would
  // otherwise fail as already-delegated) while still finishing the loop.
  if (!state.marketDelegated) {
    // Opcode 13 grows the delegation buffer incrementally (10,240 bytes
    // max per instruction, same cap as the market's own opcode-42 growth
    // -- magicblock.rs::ensure_buffer_ready), so this must be invoked
    // repeatedly until the market account's owner actually becomes the
    // Delegation Program.
    for (;;) {
      const marketInfo = await CONNECTION.getAccountInfo(market);
      if (marketInfo && marketInfo.owner.equals(DELEGATION_PROGRAM)) break;
      await send("delegate market (buffer growth or final)", [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), sg(authority.publicKey), ro(instrument), wsg(authority.publicKey), wr(buffer), wr(record), wr(metadata), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
        data: Buffer.from([13, ...VALIDATOR.toBuffer()]),
      })], [authority]);
    }
    save({ marketDelegated: true });
  } else { log("market already delegated"); }

  const members = [[pk(state.sessionA), "sessionA"], [pk(state.sessionB), "sessionB"]];
  for (const seat of [0, 1]) members.push([PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0])], PROGRAM_ID)[0], `scratch${seat}`]);
  for (const [member, name] of members) {
    const memberInfo = await CONNECTION.getAccountInfo(member);
    if (memberInfo && memberInfo.owner.equals(DELEGATION_PROGRAM)) { log(`${name} already delegated`); continue; }
    const mBuffer = PublicKey.findProgramAddressSync([Buffer.from("buffer"), member.toBuffer()], PROGRAM_ID)[0];
    const mRecord = PublicKey.findProgramAddressSync([Buffer.from("delegation"), member.toBuffer()], DELEGATION_PROGRAM)[0];
    const mMetadata = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), member.toBuffer()], DELEGATION_PROGRAM)[0];
    await send(`delegate member: ${name}`, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [ro(market), sg(authority.publicKey), wr(member), wr(mBuffer), wr(mRecord), wr(mMetadata), wsg(authority.publicKey), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
      data: Buffer.from([41, ...VALIDATOR.toBuffer()]),
    })], [authority]);
  }
  save({ delegated: true });
}

async function stageStatus() {
  const state = load();
  const market = pk(must(state, "market"));
  const info = await CONNECTION.getAccountInfo(market);
  if (!info) throw new Error("market missing");
  console.log("L1 owner:", info.owner.toBase58());
  console.log("L1 delegationStatus:", info.data[329]);
  console.log("L1 validator:", info.data[396] !== 0 ? "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57" : "(none)");
  for (const name of ["sessionA", "sessionB"]) {
    const m = state[name] ? await CONNECTION.getAccountInfo(pk(state[name])) : null;
    console.log(`L1 ${name} owner:`, m ? m.owner.toBase58() : "(missing)");
  }
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [must(state, "market")] }) });
  const body = await res.json();
  console.log("router:", JSON.stringify(body.result ?? body.error));
}

/** The full 5-account hot cluster: market + both settlement-scratch PDAs +
 * both trading-session PDAs -- re-derived deterministically rather than
 * trusted from state, matching stageDelegate's own member list exactly. */
function hotCluster(state) {
  const market = pk(state.market);
  const scratch0 = PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), Buffer.from([0, 0])], PROGRAM_ID)[0];
  const scratch1 = PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), Buffer.from([1, 0])], PROGRAM_ID)[0];
  return { market, scratch0, scratch1, sessionA: pk(state.sessionA), sessionB: pk(state.sessionB) };
}

/** The generic `devnet-router.magicblock.app` alias load-balances across
 * multiple ephemeral validators and does NOT reliably route every RPC
 * method to the SAME validator instance actually hosting a given market's
 * delegated session -- confirmed empirically: `MagicContext` (a real,
 * validator-provisioned system account every properly running ephemeral
 * validator funds at startup, per `magicblock-api::fund_account`) read as
 * `null` through the generic alias but returned real, populated data
 * through the market's own delegation record `fqdn`. Every ER call after
 * delegation must therefore target that specific fqdn, resolved once via
 * `resolveErEndpointFor` and cached for the rest of the process. */
let ER_ENDPOINT = ROUTER;
async function resolveErEndpointFor(market) {
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market] }) });
  const body = await res.json().catch(() => null);
  const fqdn = body?.result?.fqdn;
  if (!fqdn) throw new Error(`could not resolve this market's ER validator fqdn: ${JSON.stringify(body)}`);
  ER_ENDPOINT = fqdn.replace(/\/$/, "");
  log("ER endpoint resolved:", ER_ENDPOINT);
  return ER_ENDPOINT;
}

async function routerCall(method, params) {
  const res = await fetch(ER_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`${method}: router returned a non-JSON response`);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (body.result === undefined) throw new Error(`${method}: router returned neither result nor error`);
  return body.result;
}

/** Reads an account's current bytes+owner through the ER router -- the
 * authoritative live state for a delegated account, which can differ from
 * L1's (stale, pre-commit) copy. */
async function readErAccount(address) {
  const result = await routerCall("getAccountInfo", [address.toBase58(), { encoding: "base64" }]);
  if (!result?.value) return null;
  return { data: Buffer.from(result.value.data[0], "base64"), owner: result.value.owner };
}

/** `TradingSession.next_expected_nonce` (offset 201, u64 LE) -- see
 * clients/equinox/src/abi/sessions.ts::decodeTradingSession, the
 * canonical decoder this offset is taken from. */
async function readSessionNonce(sessionAddress) {
  const account = await readErAccount(sessionAddress);
  if (!account) throw new Error(`session ${sessionAddress.toBase58()} not found in the ER`);
  return account.data.readBigUInt64LE(201);
}

function readU128LE(buf, offset) {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}
function writeU128LE(buf, offset, value) {
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, offset);
  buf.writeBigUInt64LE(value >> 64n, offset + 8);
}

// PATRICIA arena layout -- clients/equinox/src/abi/orderbook.ts is the
// canonical source for every one of these offsets.
const BID_ARENA_OFFSET = 512;
const ASK_ARENA_OFFSET = 91_152;
const ARENA_CAPACITY = 1024;
const ARENA_NODES_OFFSET = 528;
const ANY_NODE_SIZE = 88;
const TAG_LEAF = 2;
const LEAF_KEY_OFFSET = 8;
const LEAF_QUANTITY_OFFSET = 24;
const LEAF_CLIENT_ORDER_ID_OFFSET = 48;
const LEAF_PRICE_OFFSET = 56;

/** Linear-scans both arenas (1,024 slots each -- a test convenience, never
 * how the on-chain program itself resolves a key) for the leaf carrying
 * `clientOrderId`, returning its real tree `key` (needed for Cancel/Replace)
 * plus quantity/price, or `null` if no resting leaf matches (cancelled,
 * fully filled, or never existed). */
function findLeafByClientOrderId(marketBytes, clientOrderId) {
  for (const arenaOffset of [BID_ARENA_OFFSET, ASK_ARENA_OFFSET]) {
    for (let i = 0; i < ARENA_CAPACITY; i++) {
      const nodeOffset = arenaOffset + ARENA_NODES_OFFSET + i * ANY_NODE_SIZE;
      if (marketBytes[nodeOffset] !== TAG_LEAF) continue;
      if (marketBytes.readBigUInt64LE(nodeOffset + LEAF_CLIENT_ORDER_ID_OFFSET) !== clientOrderId) continue;
      return {
        key: readU128LE(marketBytes, nodeOffset + LEAF_KEY_OFFSET),
        quantity: marketBytes.readBigUInt64LE(nodeOffset + LEAF_QUANTITY_OFFSET),
        price: marketBytes.readBigInt64LE(nodeOffset + LEAF_PRICE_OFFSET),
      };
    }
  }
  return null;
}

/** `TraderSeat.available_collateral`/`base_position` (i128, LE) --
 * TRADER_SEAT_OFFSET/SIZE and the field offsets within a seat are the same
 * ones `workers/src/private-sessions.ts::SEAT_FIELD_OFFSETS` uses. */
const TRADER_SEAT_OFFSET = 181_792;
const TRADER_SEAT_SIZE = 256;
function readI128LE(buf, offset) {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(buf[offset + i]);
  const signBit = 1n << 127n;
  return value >= signBit ? value - (signBit << 1n) : value;
}
function decodeSeat(marketBytes, seatIndex) {
  const base = TRADER_SEAT_OFFSET + seatIndex * TRADER_SEAT_SIZE;
  return {
    availableCollateral: readI128LE(marketBytes, base + 40),
    basePosition: readI128LE(marketBytes, base + 72),
  };
}

function placeOrderData({ side, tree, flags, seatIndex, quantity, price, expiresAt, pegLimit, clientOrderId, actionNonce }) {
  const d = Buffer.alloc(54);
  d[0] = 3; d[1] = side; d[2] = tree; d[3] = flags;
  d.writeUInt16LE(seatIndex, 4);
  d.writeBigUInt64LE(quantity, 6);
  d.writeBigInt64LE(price, 14);
  d.writeBigUInt64LE(expiresAt ?? 0n, 22);
  d.writeBigInt64LE(pegLimit ?? 0n, 30);
  d.writeBigUInt64LE(clientOrderId, 38);
  d.writeBigUInt64LE(actionNonce, 46);
  return d;
}
function cancelOrderData({ seatIndex, orderKey, actionNonce }) {
  const d = Buffer.alloc(27);
  d[0] = 4;
  d.writeUInt16LE(seatIndex, 1);
  writeU128LE(d, 3, orderKey);
  d.writeBigUInt64LE(actionNonce, 19);
  return d;
}
function replaceOrderData(oldOrderKey, fields) {
  const d = Buffer.alloc(70);
  d[0] = 33;
  writeU128LE(d, 1, oldOrderKey);
  placeOrderData(fields).copy(d, 17, 1); // drop PlaceOrder's own opcode byte
  return d;
}

/** Submits a session- or main-wallet-signed transaction through the ER,
 * fetching a fresh account-aware blockhash for the whole hot cluster each
 * time (an already-used ER blockhash cannot be replayed). Throws on any
 * router or transaction error -- never silently swallowed. */
async function sendEr(instruction, signers, clusterAddresses) {
  const result = await routerCall("getBlockhashForAccounts", [clusterAddresses]);
  // The generic router alias and a specific validator's own direct RPC
  // return this call in different shapes (flat `{blockhash,...}` vs.
  // standard-RPC-style `{context, value: {blockhash,...}}`) -- confirmed
  // empirically, not assumed. Handle both.
  const { blockhash } = result.value ?? result;
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: authority.publicKey });
  tx.add(instruction);
  tx.sign(...signers);
  const t0 = Date.now();
  const signature = await routerCall("sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64" }]);
  return { signature, ms: Date.now() - t0 };
}

async function commitCluster(cluster, clusterAddresses, sequence) {
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    // Trailing cluster members after the fixed 5 (market, authority,
    // authority-as-payer, magic context, magic program): the scratch and
    // session PDAs, so this proves and commits the WHOLE delegated
    // cluster's state -- not just the market account -- in one call
    // (magicblock.rs::commit_market_inner accepts `accounts[5..]` as
    // additional committed members).
    keys: [
      wr(cluster.market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM),
      wr(cluster.scratch0), wr(cluster.scratch1), wr(cluster.sessionA), wr(cluster.sessionB),
    ],
    data: (() => { const d = Buffer.alloc(9); d[0] = 14; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  });
  const { signature, ms } = await sendEr(instruction, [authority], clusterAddresses);
  console.log(`ER commit: sig=${signature} submitMs=${ms}`);
  return signature;
}

async function stageEr() {
  const state = load();
  if (!state.delegated) throw new Error("delegate first");
  await resolveErEndpointFor(state.market);
  const cluster = hotCluster(state);
  // The whole hot cluster, not just market+sessions: the ER's account-aware
  // blockhash must reflect every account this stage's transactions will
  // write to, and the commit below writes the scratch PDAs too.
  const clusterAddresses = [cluster.market, cluster.scratch0, cluster.scratch1, cluster.sessionA, cluster.sessionB].map((a) => a.toBase58());
  const sessionSignerA = traderKeypair("sessionSignerA");
  const sessionSignerB = traderKeypair("sessionSignerB");

  let nonceA = await readSessionNonce(cluster.sessionA);
  let nonceB = await readSessionNonce(cluster.sessionB);
  const evidence = {};

  // stageSetup's InitializeMarket leaves the market in Paused mode (its own
  // documented initial state) and never issued a ResumeMarket -- a real gap
  // found only by actually trying to place an order and getting rejected.
  // The market is delegated, so this write must go through the ER.
  {
    const bytes = (await readErAccount(cluster.market)).data;
    if (bytes[11] !== 1 /* MarketMode::Open */) {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(cluster.market), sg(authority.publicKey)],
        data: Buffer.from([26]), // ResumeMarket
      });
      const { signature, ms } = await sendEr(ix, [authority], clusterAddresses);
      console.log(`ER resume market: sig=${signature} submitMs=${ms}`);
      evidence.resumeMarket = signature;
    } else {
      log("market already Open");
    }
  }

  // Every order requires header.oracle_valid, which ONLY
  // consume_oracle_update (a real, cryptographically-verified CPI into the
  // live Pyth Lazer receiver program) can ever set -- there is no
  // admin/test bypass in the program, by design. This environment has no
  // Pyth Lazer API key (PYTH_PRO_API_KEY is unset everywhere, and an
  // anonymous WSS connection to the documented Lazer endpoints is refused
  // with HTTP 403 at the handshake -- confirmed empirically, not assumed).
  // Real session-signed trading is therefore genuinely blocked on that
  // missing credential; every stage below that doesn't need it (commit,
  // undelegate, restore, reconciled withdrawal) still proceeds against the
  // real market this session already delegated.
  const oracleReady = (await readErAccount(cluster.market)).data[294] === 1;
  if (!oracleReady) {
    log("BLOCKED: header.oracle_valid is false and no Pyth Lazer credential is available in this environment -- skipping the place/cancel/replace/cross sequence. See the final report for the exact evidence (403 at the Lazer WSS handshake).");
    save({ erSkippedTrading: "no_pyth_oracle_credential" });
    const sequence = state.commitSequence ?? 1;
    const commitSignature = await commitCluster(cluster, clusterAddresses, sequence);
    save({ commitSignature, commitSequence: sequence });
    return;
  }

  // 1. Non-crossing order: seat 0, session-signed, resting bid far below
  // any real ask (price 1) -- proves a real session-signed trade executes
  // inside the ER.
  const coid1 = BigInt(Date.now());
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(cluster.market), sg(sessionSignerA.publicKey), wr(cluster.scratch0), wr(cluster.sessionA)],
      data: placeOrderData({ side: 0, tree: 0, flags: 0, seatIndex: 0, quantity: 1n, price: 1n, clientOrderId: coid1, actionNonce: nonceA }),
    });
    const { signature, ms } = await sendEr(ix, [authority, sessionSignerA], clusterAddresses);
    console.log(`ER place (non-crossing, seat0): sig=${signature} submitMs=${ms}`);
    evidence.placeNonCrossing = signature;
    nonceA += 1n;
  }
  {
    const bytes = (await readErAccount(cluster.market)).data;
    const leaf = findLeafByClientOrderId(bytes, coid1);
    if (!leaf || leaf.quantity !== 1n || leaf.price !== 1n) throw new Error(`non-crossing order not found resting as expected: ${JSON.stringify(leaf)}`);
    log("non-crossing order confirmed resting:", leaf);
  }

  // 2. Cancel it.
  {
    const bytes = (await readErAccount(cluster.market)).data;
    const leaf = findLeafByClientOrderId(bytes, coid1);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(cluster.market), sg(sessionSignerA.publicKey), wr(cluster.sessionA)],
      data: cancelOrderData({ seatIndex: 0, orderKey: leaf.key, actionNonce: nonceA }),
    });
    const { signature, ms } = await sendEr(ix, [authority, sessionSignerA], clusterAddresses);
    console.log(`ER cancel: sig=${signature} submitMs=${ms}`);
    evidence.cancel = signature;
    nonceA += 1n;
  }
  {
    const bytes = (await readErAccount(cluster.market)).data;
    if (findLeafByClientOrderId(bytes, coid1)) throw new Error("cancelled order is still resting");
    log("cancel confirmed: order no longer resting");
  }

  // 3. Place another resting order, then replace it.
  const coid2 = BigInt(Date.now() + 1);
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(cluster.market), sg(sessionSignerA.publicKey), wr(cluster.scratch0), wr(cluster.sessionA)],
      data: placeOrderData({ side: 0, tree: 0, flags: 0, seatIndex: 0, quantity: 1n, price: 2n, clientOrderId: coid2, actionNonce: nonceA }),
    });
    const { signature, ms } = await sendEr(ix, [authority, sessionSignerA], clusterAddresses);
    console.log(`ER place (to be replaced): sig=${signature} submitMs=${ms}`);
    evidence.placeBeforeReplace = signature;
    nonceA += 1n;
  }
  const coid3 = BigInt(Date.now() + 2);
  {
    const bytes = (await readErAccount(cluster.market)).data;
    const leaf = findLeafByClientOrderId(bytes, coid2);
    if (!leaf) throw new Error("order to replace not found resting");
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(cluster.market), sg(sessionSignerA.publicKey), wr(cluster.scratch0), wr(cluster.sessionA)],
      data: replaceOrderData(leaf.key, { side: 0, tree: 0, flags: 0, seatIndex: 0, quantity: 1n, price: 3n, clientOrderId: coid3, actionNonce: nonceA }),
    });
    const { signature, ms } = await sendEr(ix, [authority, sessionSignerA], clusterAddresses);
    console.log(`ER replace: sig=${signature} submitMs=${ms}`);
    evidence.replace = signature;
    nonceA += 1n;
  }
  {
    const bytes = (await readErAccount(cluster.market)).data;
    if (findLeafByClientOrderId(bytes, coid2)) throw new Error("replaced order's old key is still resting");
    const leaf = findLeafByClientOrderId(bytes, coid3);
    if (!leaf || leaf.price !== 3n) throw new Error(`replacement order not resting as expected: ${JSON.stringify(leaf)}`);
    log("replace confirmed: old order gone, new order resting at price 3");
  }

  // 4. Crossing order: seat 1 (session B) sells into seat 0's resting bid
  // at price 3 -- a real fill, not just a resting order.
  const coid4 = BigInt(Date.now() + 3);
  const beforeBytes = (await readErAccount(cluster.market)).data;
  const before = decodeSeat(beforeBytes, 0);
  const before1 = decodeSeat(beforeBytes, 1);
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(cluster.market), sg(sessionSignerB.publicKey), wr(cluster.scratch1), wr(cluster.sessionB)],
      data: placeOrderData({ side: 1, tree: 0, flags: 0, seatIndex: 1, quantity: 1n, price: 3n, clientOrderId: coid4, actionNonce: nonceB }),
    });
    const { signature, ms } = await sendEr(ix, [authority, sessionSignerB], clusterAddresses);
    console.log(`ER place (crossing, seat1): sig=${signature} submitMs=${ms}`);
    evidence.placeCrossing = signature;
    nonceB += 1n;
  }
  {
    const bytes = (await readErAccount(cluster.market)).data;
    const after = decodeSeat(bytes, 0);
    const after1 = decodeSeat(bytes, 1);
    if (after.basePosition !== before.basePosition + 1n) throw new Error(`seat0 base_position did not increase by 1: ${before.basePosition} -> ${after.basePosition}`);
    if (after1.basePosition !== before1.basePosition - 1n) throw new Error(`seat1 base_position did not decrease by 1: ${before1.basePosition} -> ${after1.basePosition}`);
    if (findLeafByClientOrderId(bytes, coid3)) throw new Error("crossing order should have fully filled seat0's resting bid");
    log(`crossing fill confirmed: seat0 ${before.basePosition}->${after.basePosition}, seat1 ${before1.basePosition}->${after1.basePosition}`);
    evidence.seat0PositionAfterFill = after.basePosition.toString();
    evidence.seat1PositionAfterFill = after1.basePosition.toString();
  }

  save({ erEvidence: evidence, erNonceA: nonceA.toString(), erNonceB: nonceB.toString() });

  // 5. Commit the whole cluster.
  const sequence = state.commitSequence ?? 1;
  const commitSignature = await commitCluster(cluster, clusterAddresses, sequence);
  save({ commitSignature, commitSequence: sequence });

  // 6. Confirm L1 finalization: the committed positions must now be
  // readable from L1 itself, not just the ER.
  const l1Market = await CONNECTION.getAccountInfo(cluster.market);
  const l1Seat0 = decodeSeat(l1Market.data, 0);
  const l1Seat1 = decodeSeat(l1Market.data, 1);
  if (l1Seat0.basePosition.toString() !== evidence.seat0PositionAfterFill) {
    throw new Error(`L1 did not finalize seat0's position: L1=${l1Seat0.basePosition} expected=${evidence.seat0PositionAfterFill}`);
  }
  if (l1Seat1.basePosition.toString() !== evidence.seat1PositionAfterFill) {
    throw new Error(`L1 did not finalize seat1's position: L1=${l1Seat1.basePosition} expected=${evidence.seat1PositionAfterFill}`);
  }
  log(`L1 finalization confirmed: seat0=${l1Seat0.basePosition} seat1=${l1Seat1.basePosition}`);
  save({ l1FinalizedSeat0Position: l1Seat0.basePosition.toString(), l1FinalizedSeat1Position: l1Seat1.basePosition.toString() });
}

async function stageUndelegate() {
  const state = load();
  await resolveErEndpointFor(state.market);
  const cluster = hotCluster(state);
  const clusterAddresses = [cluster.market, cluster.scratch0, cluster.scratch1, cluster.sessionA, cluster.sessionB].map((a) => a.toBase58());
  const sequence = (state.commitSequence ?? 1) + 1;
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      wr(cluster.market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM),
      wr(cluster.scratch0), wr(cluster.scratch1), wr(cluster.sessionA), wr(cluster.sessionB),
    ],
    data: (() => { const d = Buffer.alloc(9); d[0] = 15; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  });
  const { signature, ms } = await sendEr(instruction, [authority], clusterAddresses);
  console.log(`ER commit-and-undelegate: sig=${signature} submitMs=${ms}`);
  save({ undelegateSignature: signature, undelegateSequence: sequence });
}

/** Waits for the Delegation Program's async external-undelegate callback
 * to actually restore the market to Equinox ownership on L1 --
 * `commit_and_undelegate`/`undelegate` only request undelegation; the real
 * ownership handoff happens later, out of band, once the validator
 * processes it. */
async function stageRestore() {
  const state = load();
  const market = pk(must(state, "market"));
  const deadline = Date.now() + 120_000;
  for (;;) {
    const info = await CONNECTION.getAccountInfo(market);
    if (info && info.owner.equals(PROGRAM_ID)) {
      log(`restored: L1 owner=${info.owner.toBase58()} delegationStatus=${info.data[329]} (3=Restored expected)`);
      save({ restored: true });
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`market did not restore to Equinox ownership within 120s (owner=${info ? info.owner.toBase58() : "missing"})`);
    }
    log(`waiting for restore... current owner=${info ? info.owner.toBase58() : "missing"}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function stageWithdraw() {
  const state = load();
  if (state.withdrawn) { log("already withdrawn:", state.withdrawn); return; }
  if (!state.restored) throw new Error("restore first (market must be back under Equinox ownership before an L1 withdrawal)");
  const market = pk(state.market);
  const mint = pk(state.mint);
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_ID)[0];
  const header = await CONNECTION.getAccountInfo(market);
  console.log("L1 delegation status:", header.data[329], "(3=Restored expected)");
  console.log("L1 market owner:", header.owner.toBase58());

  // Reconciled withdrawal: verify the vault's real token balance still
  // matches the market's own ledger (collateral + fees + insurance - bad
  // debt) after the whole delegate/trade/commit/undelegate round trip,
  // before ever withdrawing against it.
  await send("reconcile vault (op39)", [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(market), wr(vault), ro(mint), ro(TOKEN_PROGRAM)],
    data: Buffer.from([39]),
  })], [authority]);
  const reconciledHeader = await CONNECTION.getAccountInfo(market);
  // Offset 473: RESERVED_RECONCILIATION_STATUS_OFFSET, per the generated
  // clients/equinox/src/abi/layout.json (compiler-verified via
  // offset_of!, never hand-guessed).
  log("reconciliation status:", reconciledHeader.data[473], "(1=Reconciled expected)");

  const ata = await getOrCreateAssociatedTokenAccount(CONNECTION, authority, mint, traderB.publicKey);
  const before = Number((await getAccount(CONNECTION, ata.address)).amount);
  const { signature } = await send(`withdraw traderB`, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(market), sg(traderB.publicKey), wr(ata.address), ro(mint), wr(vault), ro(vaultAuthority), ro(TOKEN_PROGRAM)],
    data: (() => { const d = Buffer.alloc(11); d[0] = 11; d.writeUInt16LE(1, 1); d.writeBigUInt64LE(BigInt(DEPOSIT), 3); return d; })(),
  })], [traderB]);
  const after = Number((await getAccount(CONNECTION, ata.address)).amount);
  console.log(`traderB ATA: ${before} -> ${after} (delta ${after - before})`);
  save({ withdrawn: signature });
}

const STAGES = { setup: stageSetup, custody: stageCustody, sessions: stageSessions, delegate: stageDelegate, status: stageStatus, er: stageEr, undelegate: stageUndelegate, restore: stageRestore, withdraw: stageWithdraw };
const nonFlag = process.argv.slice(2).filter(a => !a.startsWith("--"));
const stageArg = nonFlag[0] ?? "plan";
const dryRun = process.argv.includes("--dry-run");
if (STAGES[stageArg] && !dryRun) { await STAGES[stageArg](); }
else if (stageArg === "plan") { console.log(JSON.stringify({ dryRun, stages: Object.keys(STAGES) }, null, 2)); }
else if (stageArg === "all") {
  for (const stage of ["setup", "custody", "sessions", "delegate", "er", "undelegate", "restore", "withdraw"]) {
    const state = load();
    // Each stage's REAL completion marker, not a key literally named after
    // the stage (state never has one) -- the previous version's
    // `state[stage]` check was always false, so `all` silently re-ran
    // every already-completed stage from scratch on every resume.
    const flags = { setup: state.market, custody: state.depositedB, sessions: state.sessionB, delegate: state.delegated, er: state.commitSignature, undelegate: state.undelegateSignature, restore: state.restored, withdraw: state.withdrawn };
    if (flags[stage] !== undefined && flags[stage] !== null) { log(`${stage}: complete`); continue; }
    log(`running: ${stage}`);
    await STAGES[stage]();
  }
} else { console.log("usage: node scripts/devnet-lifecycle.mjs [--dry-run] [setup|custody|sessions|delegate|status|er|undelegate|restore|withdraw|all]"); }
process.exit(0);
