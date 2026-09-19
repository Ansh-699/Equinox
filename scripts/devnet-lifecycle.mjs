#!/usr/bin/env node
/**
 * Bounded StockStream MagicBlock Devnet lifecycle.
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
const PROGRAM_ID = new PublicKey("H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET");
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
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_ID)[0];

  if (!state.vaultInitialized) {
    const vaultInfo = await CONNECTION.getAccountInfo(vault);
    if (!vaultInfo) {
      await send("create vault (op44)", [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), wr(vault), wsg(authority.publicKey), ro(mint), ro(TOKEN_PROGRAM), ro(vaultAuthority), ro(SystemProgram.programId)],
        data: Buffer.from([44]),
      })], [authority]);
    }
    save({ vaultInitialized: true });
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
    const seatSlot = Keypair.generate();
    await send(`seat-slot ${seat}`, [SystemProgram.createAccount({
      fromPubkey: authority.publicKey, newAccountPubkey: seatSlot.publicKey, lamports: 5000, space: 0, programId: PROGRAM_ID,
    })], [authority, seatSlot]).catch(() => {});
    const deposited = seat === 0 ? state.depositedA : state.depositedB;
    if (!deposited) {
      await send(`deposit ${seat}`, [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), sg(trader.publicKey), wr(seatSlot.publicKey), wr(ata.address), wr(vault), ro(mint), ro(TOKEN_PROGRAM)],
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
      // Opcode 45: the program CPI-creates the scratch PDA (PDA cannot sign top-level).
      await send(`create scratch ${seat}`, [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [ro(market), wr(scratch), wsg(authority.publicKey), sg(trader.publicKey), ro(SystemProgram.programId)],
        data: Buffer.from([45, seat, 0]),
      })], [trader, authority]);
      await send(`init scratch ${seat}`, [new TransactionInstruction({ programId: PROGRAM_ID, keys: [wr(market), sg(trader.publicKey), wr(scratch)], data: Buffer.from([8, seat, 0]) })], [trader]);
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

  await send("delegate market", [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(market), sg(authority.publicKey), ro(instrument), wsg(authority.publicKey), wr(buffer), wr(record), wr(metadata), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
    data: Buffer.from([13, ...VALIDATOR.toBuffer()]),
  })], [authority]);
  save({ delegated: true });

  const members = [[pk(state.sessionA), "sessionA"], [pk(state.sessionB), "sessionB"]];
  for (const seat of [0, 1]) members.push([PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0])], PROGRAM_ID)[0], `scratch${seat}`]);
  for (const [member, name] of members) {
    const mBuffer = PublicKey.findProgramAddressSync([Buffer.from("buffer"), member.toBuffer()], PROGRAM_ID)[0];
    const mRecord = PublicKey.findProgramAddressSync([Buffer.from("delegation"), member.toBuffer()], DELEGATION_PROGRAM)[0];
    const mMetadata = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), member.toBuffer()], DELEGATION_PROGRAM)[0];
    await send(`delegate member: ${name}`, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [ro(market), sg(authority.publicKey), wr(member), wr(mBuffer), wr(mRecord), wr(mMetadata), wsg(authority.publicKey), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
      data: Buffer.from([41, ...VALIDATOR.toBuffer()]),
    })], [authority]);
  }
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

async function stageEr() {
  const state = load();
  if (!state.delegated) throw new Error("delegate first");
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [[state.market, state.sessionA, state.sessionB]] }) });
  const body = await res.json();
  if (!body.result) throw new Error(`getBlockhashForAccounts: ${JSON.stringify(body.error)}`);
  const { blockhash } = body.result;
  console.log("router blockhash:", blockhash.slice(0, 16) + "…");
  save({ erBlockhash: blockhash });

  const sequence = state.commitSequence ?? 1;
  const t0 = Date.now();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: authority.publicKey });
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(state.market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM)],
    data: (() => { const d = Buffer.alloc(9); d[0] = 14; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  }));
  tx.sign(authority);
  const er = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [tx.serialize().toString("base64"), { encoding: "base64" }] }) });
  const erBody = await er.json();
  if (erBody.error) { console.log(`ER commit: error ${JSON.stringify(erBody.error).slice(0, 200)}`); return; }
  console.log(`ER commit: sig=${erBody.result} submitMs=${Date.now() - t0}`);
  save({ commitSignature: erBody.result, commitSequence: sequence });
}

async function stageUndelegate() {
  const state = load();
  const sequence = (state.commitSequence ?? 1) + 1;
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [[state.market]] }) });
  const { result } = await res.json();
  const t0 = Date.now();
  const tx = new Transaction({ recentBlockhash: result.blockhash, feePayer: authority.publicKey });
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(state.market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM)],
    data: (() => { const d = Buffer.alloc(9); d[0] = 15; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  }));
  tx.sign(authority);
  const er = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sendTransaction", params: [tx.serialize().toString("base64"), { encoding: "base64" }] }) });
  const body = await er.json();
  if (body.error) { console.log(`ER undelegate: error ${JSON.stringify(body.error).slice(0, 200)}`); return; }
  console.log(`ER undelegate: sig=${body.result} submitMs=${Date.now() - t0}`);
  save({ undelegateSignature: body.result, undelegateSequence: sequence });
}

async function stageWithdraw() {
  const state = load();
  const market = pk(state.market);
  const mint = pk(state.mint);
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_ID)[0];
  const header = await CONNECTION.getAccountInfo(market);
  console.log("L1 delegation status:", header.data[329], "(3=Restored expected)");
  console.log("L1 market owner:", header.owner.toBase58());
  const ata = await getOrCreateAssociatedTokenAccount(CONNECTION, authority, mint, traderB.publicKey);
  const before = Number((await getAccount(CONNECTION, ata.address)).amount);
  await send(`withdraw traderB`, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(market), sg(traderB.publicKey), wr(ata.address), ro(mint), wr(vault), ro(vaultAuthority), ro(TOKEN_PROGRAM)],
    data: (() => { const d = Buffer.alloc(11); d[0] = 11; d.writeUInt16LE(1, 1); d.writeBigUInt64LE(BigInt(DEPOSIT), 3); return d; })(),
  })], [traderB]);
  const after = Number((await getAccount(CONNECTION, ata.address)).amount);
  console.log(`traderB ATA: ${before} -> ${after} (delta ${after - before})`);
}

const STAGES = { setup: stageSetup, custody: stageCustody, sessions: stageSessions, delegate: stageDelegate, status: stageStatus, er: stageEr, undelegate: stageUndelegate, withdraw: stageWithdraw };
const nonFlag = process.argv.slice(2).filter(a => !a.startsWith("--"));
const stageArg = nonFlag[0] ?? "plan";
const dryRun = process.argv.includes("--dry-run");
if (STAGES[stageArg] && !dryRun) { await STAGES[stageArg](); }
else if (stageArg === "plan") { console.log(JSON.stringify({ dryRun, stages: Object.keys(STAGES) }, null, 2)); }
else if (stageArg === "all") {
  for (const stage of ["setup", "custody", "sessions", "delegate", "er", "undelegate", "withdraw"]) {
    const state = load();
    const flags = { setup: state.market, custody: state.depositedB, sessions: state.sessionB, delegate: state.delegated, er: state.commitSignature, undelegate: state.undelegateSignature, withdraw: state.withdrawn };
    if (state[stage] !== undefined && state[stage] !== null) { log(`${stage}: complete`); continue; }
    log(`running: ${stage}`);
    await STAGES[stage]();
  }
} else { console.log("usage: node scripts/devnet-lifecycle.mjs [--dry-run] [setup|custody|sessions|delegate|status|er|undelegate|withdraw|all]"); }
process.exit(0);
