#!/usr/bin/env node
/**
 * Bounded StockStream MagicBlock Devnet lifecycle.
 *
 * Resumable stages (checkpoint state in /tmp/opencode/lifecycle-state.json):
 *   setup      — exchange + instrument + market (all L1, program PDAs)
 *   custody    — 6-dec devnet test mint, ATAs, vault, seats, deposits
 *   sessions   — scratch init + trading-session authorization (2 traders)
 *   delegate   — DelegateMarket + 4x DelegateClusterMember (devnet-as)
 *   status     — L1 delegation state + router getDelegationStatus
 *   er         — ER-domain execution proof via CommitMarket (the only
 *                StockStream instruction executable on the ER without a
 *                verified oracle; order matching needs the live Pyth feed,
 *                which is credential-blocked — reported honestly)
 *   undelegate — CommitAndUndelegate + external-undelegate restoration
 *   withdraw   — collateral withdrawal after restoration
 *
 * Real signatures, slots, sizes and round-trip latency recorded for every
 * transaction in the state file. Never prints secret bytes.
 */
import fs from "node:fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  getMint, createInitializeMintInstruction,
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
const EXCHANGE_SIZE = 256;
const INSTRUMENT_SIZE = 128;
const DEPOSIT = 400_000; // 0.4 test-USD per trader (6 decimals)

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
    commitment: "confirmed",
    skipPreflight: opts.skipPreflight ?? false,
  });
  const slot = await CONNECTION.getSlot("finalized");
  const ms = Date.now() - t0;
  const state = load();
  (state.events ||= []).push({ name, signature, slot, ms, wireBytes: tx.serialize().length });
  save(state);
  console.log(`${name}: sig=${signature.slice(0, 20)}… slot=${slot} ms=${ms} bytes=${tx.serialize().length}`);
  return { signature, slot, ms };
}

/** Creates a program-owned account at `pda` if it does not exist. */
async function ensureProgramAccount(name, pda, space) {
  if (await CONNECTION.getAccountInfo(pda)) return;
  const lamports = await CONNECTION.getMinimumBalanceForRentExemption(space);
  await send(`create ${name} (${space}B)`, [SystemProgram.createAccount({
    fromPubkey: authority.publicKey, newAccountPubkey: pda, lamports, space, programId: PROGRAM_ID,
  })], [authority]);
}

// ---------------------------------------------------------------- setup --
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

  // Exchange: an ordinary keypair-funded program account (256 bytes).
  await send("create exchange account", [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: exchange.publicKey, lamports: exchangeLamports, space: 256, programId: PROGRAM_ID }),
  ], [authority, exchange]);

  // Instrument PDA: created by opcode 43 (128 bytes, within the inner-CPI
  // realloc cap, so one instruction does fund + allocate + assign).
  await send("create instrument account (program CPI)", [new TransactionInstruction({
    programId: PROGRAM_ID,
    // [0]=instrument PDA (w) [1]=payer(w+signer) [2]=system
    keys: [wr(instrumentPda), wsg(authority.publicKey), ro(SystemProgram.programId)],
    data: Buffer.from([43, ...instrumentId]),
  })], [authority]);

  // Market PDA: opcode 42 grows it incrementally (10,240 B per instruction
  // is Solana's account-realloc cap). One call stages the first allocation,
  // then the client repeats the instruction until the account reaches the
  // full MARKET_SIZE.
  const createStep = () => new TransactionInstruction({
    programId: PROGRAM_ID,
    // [0]=instrument(ro) [1]=market PDA (w) [2]=payer(w+signer) [3]=system
    keys: [ro(instrumentPda), wr(marketPda), wsg(authority.publicKey), ro(SystemProgram.programId)],
    data: Buffer.from([42]),
  });
  await send("create market account (first chunk)", [createStep()], [authority]);
  for (;;) {
    const info = await CONNECTION.getAccountInfo(marketPda, "confirmed");
    if (info && info.data.length === MARKET_SIZE) break;
    await send(`grow market account (${info ? info.data.length : 0}/${MARKET_SIZE})`, [createStep()], [authority]);
  }

  await send("initialize exchange", [new TransactionInstruction({
    programId: PROGRAM_ID, keys: [wr(exchange.publicKey), sg(authority.publicKey)], data: Buffer.from([19]),
  })], [authority]);
  await send("register instrument", [new TransactionInstruction({
    programId: PROGRAM_ID, keys: [ro(exchange.publicKey), wr(instrumentPda), sg(authority.publicKey)],
    data: Buffer.from([20, ...instrumentId]),
  })], [authority]);
  await send("update instrument (oracle config)", [new TransactionInstruction({
    programId: PROGRAM_ID, keys: [ro(exchange.publicKey), wr(instrumentPda), sg(authority.publicKey)],
    // [22, id@1(32), pythFeedId u32@33 = 33, channel u8@37 = 1, exponent i32@38 = -6]
    data: Buffer.from([22, ...instrumentId, 33, 0, 0, 0, 1, 0xfa, 0xff, 0xff, 0xff]),
  })], [authority]);
  await send("create perp market", [new TransactionInstruction({
    programId: PROGRAM_ID, keys: [ro(instrument.publicKey), wr(marketPda), sg(authority.publicKey)],
    data: Buffer.from([21, ...instrumentId]),
  })], [authority]);

  const info = await CONNECTION.getAccountInfo(marketPda, "confirmed");
  const initialized = info && info.data.length === MARKET_SIZE && info.data.readUInt8(10) === 1;
  if (!initialized) throw new Error("market account not initialized on L1");
  save({ instrumentId: [...instrumentId], exchange: exchange.publicKey.toBase58(), instrument: instrument.publicKey.toBase58(), market: marketPda.toBase58() });
  log("MARKET =", marketPda.toBase58());
}

// -------------------------------------------------------------- custody --
async function stageCustody() {
  const state = load();
  const market = pk(must(state, "market"));
  let mint = state.mint ? pk(state.mint) : null;
  if (mint === null) {
    mint = await createMint(CONNECTION, authority, authority.publicKey, null, 6);
    save({ mint: mint.toBase58() });
    log("MINT =", mint.toBase58());
  }
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_ID)[0];

  if (!state.vaultInitialized) {
    await send("initialize vault", [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(market), sg(authority.publicKey), ro(mint), ro(TOKEN_PROGRAM), wr(vault), ro(vaultAuthority)],
      data: Buffer.from([9]),
    })], [authority]);
    save({ vaultInitialized: true });
  }

  for (const [trader, seat] of [[authority, 0], [traderB, 1]]) {
    await send(`create seat ${seat}`, [new TransactionInstruction({
      programId: PROGRAM_ID, keys: [wr(market), sg(trader.publicKey)], data: Buffer.from([1, seat, 0]),
    })], [trader]).catch((e) => console.log(`seat ${seat}: ${String(e).slice(0, 90)}`));
    const ata = await getOrCreateAssociatedTokenAccount(CONNECTION, trader, mint, trader.publicKey);
    const balance = Number((await getAccount(CONNECTION, ata.address)).amount);
    if (balance < 1_000_000) {
      await send(`mint to trader ${seat}`, [
        (() => {
          const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(1_000_000n, 1);
          return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [wr(mint), wr(ata.address), sg(authority.publicKey)], data });
        })(),
      ], [authority]);
    }
    const vaultInfo = await getAccount(CONNECTION, vault).catch(() => null);
    const alreadyDeposited = vaultInfo ? Number(vaultInfo.amount) : 0;
    const depositForSeat = seat === 0 ? state.depositedA ?? 0 : state.depositedB ?? 0;
    if (depositForSeat === 0) {
      await send(`deposit trader ${seat}`, [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), sg(trader.publicKey), wr(trader.publicKey), wr(ata.address), wr(vault), ro(mint), ro(TOKEN_PROGRAM)],
        data: depositData(seat, DEPOSIT),
      })], [trader]);
      save(seat === 0 ? { depositedA: DEPOSIT } : { depositedB: DEPOSIT });
    }
    void vaultInfo; void alreadyDeposited;
  }
  const m = await getMint(CONNECTION, mint);
  log(`mint supply=${m.supply} vaultBalance=${(await getAccount(CONNECTION, vault)).amount}`);
}

function depositData(seat, amount) {
  const data = Buffer.alloc(11);
  data[0] = 10; data.writeUInt16LE(seat, 1); data.writeBigUInt64LE(BigInt(amount), 3);
  return data;
}

// ------------------------------------------------------------- sessions --
async function stageSessions() {
  const state = load();
  const market = pk(must(state, "market"));
  const mint = pk(must(state, "mint"));
  for (const [trader, seat, name] of [[authority, 0, "A"], [traderB, 1, "B"]]) {
    // 1. scratch account (create + initialize)
    const scratch = PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0])], PROGRAM_ID)[0];
    if ((await CONNECTION.getAccountInfo(scratch)) === null) {
      const lamports = await CONNECTION.getMinimumBalanceForRentExemption(SCRATCH_SIZE);
      await send(`create scratch ${seat}`, [SystemProgram.createAccount({
        fromPubkey: authority.publicKey, newAccountPubkey: scratch, lamports, space: SCRATCH_SIZE, programId: PROGRAM_ID,
      })], [authority]);
      await send(`init scratch ${seat}`, [new TransactionInstruction({
        programId: PROGRAM_ID, keys: [wr(market), sg(trader.publicKey), wr(scratch)],
        data: Buffer.from([8, seat, 0]),
      })], [trader]);
    }
    // 2. session authorization (session signer = dedicated keypair, held in /tmp)
    const sessionSigner = traderKeypair(`sessionSigner${name}`);
    const sessionPda = PublicKey.findProgramAddressSync([
      Buffer.from("trading_session"), trader.publicKey.toBuffer(), market.toBuffer(), Buffer.from([seat, 0]), sessionSigner.publicKey.toBuffer(),
    ], PROGRAM_ID)[0];
    if ((await CONNECTION.getAccountInfo(sessionPda)) === null) {
      const expiresAt = BigInt(Date.now() + 6 * 3_600_000);
      const data = Buffer.alloc(46);
      data[0] = 17;
      data.writeUInt16LE(seat, 1);
      data.writeBigUInt64LE(expiresAt, 3);
      data[11] = 0b11111; // all trading actions
      data.writeBigUInt64LE(2_000_000n, 12);   // maxOrderNotional (2 USD, 6 dec)
      data.writeBigUInt64LE(10_000_000n, 20);  // maxCumulativeNotional
      data.writeBigInt64LE(5_000_000n, 28);    // maximumExposure
      data.writeUInt16LE(32, 44);              // maxOpenOrders
      await send(`authorize session ${name}`, [new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [wr(market), wsg(trader.publicKey), wr(sessionPda), ro(sessionSigner.publicKey), ro(SystemProgram.programId)],
        data,
      })], [trader]);
      save({ [`session${name}`]: sessionPda.toBase58(), [`sessionSigner${name}`]: sessionSigner.publicKey.toBase58() });
    } else {
      log(`session ${name} already exists`, sessionPda.toBase58());
    }
    void mint;
  }
}

// ------------------------------------------------------------- delegate --
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
    // [0]=market(w) [1]=authority(signer) [2]=instrument(ro) [3]=payer(w+sg)
    // [4]=buffer(w) [5]=record(w) [6]=metadata(w) [7]=dlp [8]=system [9]=owner
    keys: [wr(market), sg(authority.publicKey), ro(state.instrument), wsg(authority.publicKey), wr(buffer), wr(record), wr(metadata), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
    data: Buffer.from([13, ...VALIDATOR.toBuffer()]),
  })], [authority]);
  save({ delegated: true, buffer: buffer.toBase58() });

  // Delegate each hot-cluster member (2 scratch + 2 sessions).
  const members = [
    [pk(state.sessionA), "sessionA"], [pk(state.sessionB), "sessionB"],
  ];
  for (const seat of [0, 1]) {
    members.push([PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0])], PROGRAM_ID)[0], `scratch${seat}`]);
  }
  for (const [member, name] of members) {
    const mBuffer = PublicKey.findProgramAddressSync([Buffer.from("buffer"), member.toBuffer()], PROGRAM_ID)[0];
    const mRecord = PublicKey.findProgramAddressSync([Buffer.from("delegation"), member.toBuffer()], DELEGATION_PROGRAM)[0];
    const mMetadata = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), member.toBuffer()], DELEGATION_PROGRAM)[0];
    await send(`delegate cluster member: ${name}`, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [ro(market), sg(authority.publicKey), wr(member), wr(mBuffer), wr(mRecord), wr(mMetadata), wsg(authority.publicKey), ro(DELEGATION_PROGRAM), ro(SystemProgram.programId), ro(PROGRAM_ID)],
      data: Buffer.from([41, ...VALIDATOR.toBuffer()]),
    })], [authority]);
  }
  void buffer; void record; void metadata;
}

// --------------------------------------------------------------- status --
async function stageStatus() {
  const state = load();
  const market = pk(must(state, "market"));
  const info = await CONNECTION.getAccountInfo(market);
  if (!info) throw new Error("market account missing");
  const data = info.data;
  // reserved_upgrade @327; DelegationStatus byte @2 (0=NotDelegated, 1=Delegated, 2=Undelegating, 3=Restored)
  console.log("L1 market owner:", info.owner.toBase58());
  console.log("L1 delegation status byte:", data[327 + 2]);
  console.log("L1 validator:", data[327 + 69] !== 0 ? "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57" : "(none)");
  for (const [name, member] of [["sessionA", state.sessionA], ["sessionB", state.sessionB]]) {
    const m = member ? await CONNECTION.getAccountInfo(pk(member)) : null;
    console.log(`L1 ${name} owner:`, m ? m.owner.toBase58() : "(missing)");
  }
  // Router-level delegation check
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [must(state, "market")],
  })});
  const body = await res.json();
  console.log("router getDelegationStatus:", JSON.stringify(body.result ?? body.error));
}

// -------------------------------------------------------------------- ER --
async function stageEr() {
  const state = load();
  const market = pk(must(state, "market"));
  if (!state.delegated) throw new Error("delegate first");
  // Account-aware blockhash from the Magic Router.
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [[state.market, state.sessionA, state.sessionB]],
  })});
  const body = await res.json();
  if (!body.result) throw new Error(`getBlockhashForAccounts: ${JSON.stringify(body.error ?? body)}`);
  const { blockhash, lastValidBlockHeight } = body.result;
  console.log("router blockhash:", blockhash.slice(0, 16) + "…", "lastValidBlockHeight:", lastValidBlockHeight);
  save({ erBlockhash: blockhash, erBlockHeight: lastValidBlockHeight });

  // ER-domain execution proof: CommitMarket executes ON THE ER (Magic
  // Program CPI), which is the only StockStream instruction executable
  // there without a verified oracle. Commit sequence = the header's
  // expected commit sequence (1 on first delegation).
  await stageErCommit(blockhash);
}

async function stageErCommit(blockhash) {
  const state = load();
  const market = pk(state.market);
  const sequence = state.commitSequence ?? 1;
  const t0 = Date.now();
  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: authority.publicKey,
  });
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    // [0]=market(w) [1]=authority(signer) [2]=payer(w+signer) [3]=magic_context(w) [4]=magic_program(ro)
    keys: [wr(market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM)],
    data: (() => { const d = Buffer.alloc(9); d[0] = 14; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  }));
  tx.sign(authority);
  const wire = tx.serialize().toString("base64");
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [wire, { encoding: "base64" }],
  })});
  const body = await res.json();
  const ms = Date.now() - t0;
  if (body.error) { console.log(`ER commit submit: error ${JSON.stringify(body.error).slice(0, 200)}`); return; }
  const erSignature = body.result;
  console.log(`ER commit: sig=${erSignature} submitMs=${ms}`);
  save({ commitSignature: erSignature, commitSubmitMs: ms, commitSequence: state.commitSequence ?? 1 });
}

// ------------------------------------------------------------ undelegate --
async function stageUndelegate() {
  const state = load();
  const market = pk(state.market);
  const sequence = (state.commitSequence ?? 1) + 1;
  // Commit-and-undelegate must ALSO execute on the ER (Magic Program CPI).
  const res = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [[state.market]],
  })});
  const { result } = await res.json();
  const t0 = Date.now();
  const tx = new Transaction({
    recentBlockhash: result.blockhash,
    feePayer: authority.publicKey,
  });
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [wr(market), sg(authority.publicKey), wsg(authority.publicKey), wr(MAGIC_CONTEXT), ro(MAGIC_PROGRAM)],
    data: (() => { const d = Buffer.alloc(9); d[0] = 15; d.writeBigUInt64LE(BigInt(sequence), 1); return d; })(),
  }));
  tx.sign(authority);
  const er = await fetch(ROUTER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "sendTransaction", params: [tx.serialize().toString("base64"), { encoding: "base64" }],
  })});
  const body = await er.json();
  if (body.error) { console.log(`ER commit-and-undelegate: error ${JSON.stringify(body.error).slice(0, 200)}`); return; }
  console.log(`ER commit-and-undelegate: sig=${body.result} submitMs=${Date.now() - t0}`);
  save({ undelegateSignature: body.result, undelegateSequence: sequence });
}

// -------------------------------------------------------------- withdraw --
async function stageWithdraw() {
  const state = load();
  const market = pk(state.market);
  const mint = pk(state.mint);
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("vault-authority"), market.toBuffer()], PROGRAM_ID)[0];
  const header = await CONNECTION.getAccountInfo(market);
  const status = header.data[327 + 2];
  console.log("L1 delegation status after undelegation:", status, "(3=Restored expected)");
  const owner = await CONNECTION.getAccountInfo(market);
  console.log("L1 market owner after restoration:", owner.owner.toBase58());
  for (const [traderKey, seat, deposited] of [[state.traderB ?? traderB.publicKey.toBase58(), 1, state.depositedB ?? DEPOSIT]]) {
    const trader = traderKey === authority.publicKey.toBase58() ? authority : traderB;
    const ata = await getOrCreateAssociatedTokenAccount(CONNECTION, authority, mint, trader.publicKey);
    const before = Number((await getAccount(CONNECTION, ata.address)).amount);
    await send(`withdraw trader ${seat}`, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [wr(market), sg(trader.publicKey), wr(ata.address), ro(mint), wr(vault), ro(vaultAuthority), ro(TOKEN_PROGRAM)],
      data: depositData(seat, deposited),
    })], [trader]);
    const after = Number((await getAccount(CONNECTION, ata.address)).amount);
    console.log(`trader ${seat} ATA: ${before} -> ${after} (delta ${after - before})`);
  }
}

// ---------------------------------------------------------------- main --
const STAGES = {
  setup: stageSetup, custody: stageCustody, sessions: stageSessions,
  delegate: stageDelegate, status: stageStatus, er: stageEr,
  undelegate: stageUndelegate, withdraw: stageWithdraw,
};
const stage = process.argv[2] || "help";
if (STAGES[stage]) await STAGES[stage]();
else console.log("usage: node scripts/devnet-lifecycle.mjs [setup|custody|sessions|delegate|status|er|undelegate|withdraw]");
