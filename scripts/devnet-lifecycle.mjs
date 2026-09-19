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
    const marketInfo = await CONNECTION.getAccountInfo(market);
    if (marketInfo && marketInfo.owner.equals(DELEGATION_PROGRAM)) {
      save({ marketDelegated: true });
    } else {
      await send("delegate market", [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), sg(authority.publicKey), ro(instrument), wsg(authority.publicKey), wr(buffer), wr(record), wr(metadata), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
        data: Buffer.from([13, ...VALIDATOR.toBuffer()]),
      })], [authority]);
      save({ marketDelegated: true });
    }
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

async function routerCall(method, params) {
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`${method}: router returned a non-JSON response`);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (body.result === undefined) throw new Error(`${method}: router returned neither result nor error`);
  return body.result;
}

async function stageEr() {
  const state = load();
  if (!state.delegated) throw new Error("delegate first");
  const cluster = hotCluster(state);
  // The whole hot cluster, not just market+sessions: the ER's account-aware
  // blockhash must reflect every account this stage's transactions will
  // write to, and the order commit below writes the scratch PDAs too.
  const clusterAddresses = [cluster.market, cluster.scratch0, cluster.scratch1, cluster.sessionA, cluster.sessionB].map((a) => a.toBase58());
  const { blockhash: orderBlockhash } = await routerCall("getBlockhashForAccounts", [clusterAddresses]);
  save({ erBlockhash: orderBlockhash });

  // A real trading action inside the ER, not just a commit of unchanged
  // state: a resting, non-crossing bid (price 1, far below any real ask)
  // from seat 0's own settlement scratch, proving delegated execution
  // actually mutates the book before it's ever committed back to L1.
  const orderTx = new Transaction({ recentBlockhash: orderBlockhash, feePayer: authority.publicKey });
  orderTx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(cluster.market), sg(authority.publicKey), wr(cluster.scratch0)],
    data: (() => {
      const d = Buffer.alloc(54);
      d[0] = 3; d[1] = 0; d[2] = 0; d[3] = 0; // PlaceOrder, bid, fixed tree, no flags
      d.writeUInt16LE(0, 4); // seatIndex
      d.writeBigUInt64LE(1n, 6); // quantity
      d.writeBigInt64LE(1n, 14); // priceOrOffset
      d.writeBigUInt64LE(0n, 22); // expiresAt (none)
      d.writeBigInt64LE(0n, 30); // pegLimit (unused for a fixed-tree order)
      d.writeBigUInt64LE(BigInt(Date.now()), 38); // clientOrderId
      d.writeBigUInt64LE(0n, 46); // actionNonce (main-wallet action)
      return d;
    })(),
  }));
  orderTx.sign(authority);
  const orderT0 = Date.now();
  const orderSignature = await routerCall("sendTransaction", [orderTx.serialize().toString("base64"), { encoding: "base64" }]);
  console.log(`ER order: sig=${orderSignature} submitMs=${Date.now() - orderT0}`);
  save({ erOrderSignature: orderSignature });

  // Re-fetch the blockhash for the commit -- the order above already
  // consumed the previous one.
  const { blockhash: commitBlockhash } = await routerCall("getBlockhashForAccounts", [clusterAddresses]);
  const sequence = state.commitSequence ?? 1;
  const t0 = Date.now();
  const tx = new Transaction({ recentBlockhash: commitBlockhash, feePayer: authority.publicKey });
  tx.add(new TransactionInstruction({
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
  }));
  tx.sign(authority);
  const commitSignature = await routerCall("sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64" }]);
  console.log(`ER commit: sig=${commitSignature} submitMs=${Date.now() - t0}`);
  save({ commitSignature, commitSequence: sequence });
}

async function stageUndelegate() {
  const state = load();
  const cluster = hotCluster(state);
  const clusterAddresses = [cluster.market, cluster.scratch0, cluster.scratch1, cluster.sessionA, cluster.sessionB].map((a) => a.toBase58());
  const { blockhash } = await routerCall("getBlockhashForAccounts", [clusterAddresses]);
  const sequence = (state.commitSequence ?? 1) + 1;
  const t0 = Date.now();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: authority.publicKey });
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      wr(cluster.market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM),
      wr(cluster.scratch0), wr(cluster.scratch1), wr(cluster.sessionA), wr(cluster.sessionB),
    ],
    data: (() => { const d = Buffer.alloc(9); d[0] = 15; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  }));
  tx.sign(authority);
  const signature = await routerCall("sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64" }]);
  console.log(`ER undelegate: sig=${signature} submitMs=${Date.now() - t0}`);
  save({ undelegateSignature: signature, undelegateSequence: sequence });
}

async function stageWithdraw() {
  const state = load();
  if (state.withdrawn) { log("already withdrawn:", state.withdrawn); return; }
  const market = pk(state.market);
  const mint = pk(state.mint);
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_ID)[0];
  const header = await CONNECTION.getAccountInfo(market);
  console.log("L1 delegation status:", header.data[329], "(3=Restored expected)");
  console.log("L1 market owner:", header.owner.toBase58());
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

const STAGES = { setup: stageSetup, custody: stageCustody, sessions: stageSessions, delegate: stageDelegate, status: stageStatus, er: stageEr, undelegate: stageUndelegate, withdraw: stageWithdraw };
const nonFlag = process.argv.slice(2).filter(a => !a.startsWith("--"));
const stageArg = nonFlag[0] ?? "plan";
const dryRun = process.argv.includes("--dry-run");
if (STAGES[stageArg] && !dryRun) { await STAGES[stageArg](); }
else if (stageArg === "plan") { console.log(JSON.stringify({ dryRun, stages: Object.keys(STAGES) }, null, 2)); }
else if (stageArg === "all") {
  for (const stage of ["setup", "custody", "sessions", "delegate", "er", "undelegate", "withdraw"]) {
    const state = load();
    // Each stage's REAL completion marker, not a key literally named after
    // the stage (state never has one) -- the previous version's
    // `state[stage]` check was always false, so `all` silently re-ran
    // every already-completed stage from scratch on every resume.
    const flags = { setup: state.market, custody: state.depositedB, sessions: state.sessionB, delegate: state.delegated, er: state.commitSignature, undelegate: state.undelegateSignature, withdraw: state.withdrawn };
    if (flags[stage] !== undefined && flags[stage] !== null) { log(`${stage}: complete`); continue; }
    log(`running: ${stage}`);
    await STAGES[stage]();
  }
} else { console.log("usage: node scripts/devnet-lifecycle.mjs [--dry-run] [setup|custody|sessions|delegate|status|er|undelegate|withdraw|all]"); }
process.exit(0);
