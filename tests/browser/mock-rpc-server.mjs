// Minimal mock Solana JSON-RPC server for Playwright E2E tests. Byte
// layouts mirror lib/rpc-transport.test.ts's own fixture helpers (already
// verified against the real decoders there) rather than being re-derived
// independently -- see that file's marketBytes()/sessionBytes() for the
// same offsets with the same comments.
import http from "node:http";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

const PROGRAM_ID = "BY81jGEfzwuqGkJbyYaGBty5Pn6oZLfntYUFkV85XZfo";
const PORT = Number(process.env.MOCK_RPC_PORT ?? 4181);
const V3_CORE = process.env.MOCK_V3_CORE_ADDRESS ?? "";
const AUTHORIZE_TRADING_SESSION = 17;
const REVOKE_TRADING_SESSION = 18;

const programKey = new PublicKey(PROGRAM_ID);
const v3CoreKey = V3_CORE ? new PublicKey(V3_CORE) : null;
const v3Addresses = new Map();
if (v3CoreKey) {
  v3Addresses.set(v3CoreKey.toBase58(), "core");
  for (let side = 0; side < 2; side += 1) for (let page = 0; page < 9; page += 1) {
    const [address] = PublicKey.findProgramAddressSync([Buffer.from("book-page-v3"), v3CoreKey.toBuffer(), Buffer.from([side]), Buffer.from([page])], programKey);
    v3Addresses.set(address.toBase58(), `book:${side}:${page}`);
  }
  for (let shard = 0; shard < 4; shard += 1) {
    const [seat] = (await import("@solana/web3.js")).PublicKey.findProgramAddressSync([Buffer.from("seat-shard-v3"), v3CoreKey.toBuffer(), Buffer.from([shard])], programKey);
    const [event] = (await import("@solana/web3.js")).PublicKey.findProgramAddressSync([Buffer.from("event-shard-v3"), v3CoreKey.toBuffer(), Buffer.from([shard])], programKey);
    v3Addresses.set(seat.toBase58(), `seat:${shard}`);
    v3Addresses.set(event.toBase58(), `event:${shard}`);
  }
}

// Mutable in-memory state a test can steer via POST /control -- e.g. to
// simulate a not-yet-occupied seat or a revoked session.
const state = {
  seatOccupied: true,
  seatAvailableCollateral: 5_000_000n,
};

function writeI128LE(buffer, offset, value) {
  const unsigned = value < 0n ? value + (1n << 128n) : value;
  for (let i = 0; i < 16; i += 1) buffer[offset + i] = Number((unsigned >> BigInt(8 * i)) & 0xffn);
}

function marketBytes() {
  const bytes = Buffer.alloc(222_752);
  bytes.write("STKMRK01");
  bytes.writeUInt16LE(2, 8);
  bytes[10] = 1; // initialized
  bytes[11] = 1; // mode = Open
  Buffer.from(new Uint8Array(32).fill(1)).copy(bytes, 12); // marketAuthority
  bytes[294] = 1; // oracleValid
  bytes.writeBigInt64LE(100n, 295); // lastVerifiedOraclePrice
  bytes.writeBigUInt64LE(1n, 303); // lastVerifiedOracleTimestamp
  bytes.writeUInt32LE(512, 311); // bidArenaOffset
  bytes.writeUInt32LE(91152, 315); // askArenaOffset
  bytes.writeUInt32LE(181792, 319); // traderSeatOffset
  bytes.writeUInt32LE(214560, 323); // fillEventOffset
  bytes.writeBigUInt64LE(7n, 262); // globalEventSequence
  bytes.writeBigUInt64LE(4n, 330); // lastCommittedSequence
  bytes[329] = 0; // delegationStatus = NotDelegated

  if (state.seatOccupied) {
    const seatStart = 181_792;
    bytes[seatStart + 0] = 1; // occupancy
    if (globalThis.__e2eOwnerBytes) globalThis.__e2eOwnerBytes.copy(bytes, seatStart + 1);
    writeI128LE(bytes, seatStart + 40, state.seatAvailableCollateral); // availableCollateral
    writeI128LE(bytes, seatStart + 56, 0n); // reservedMargin
    writeI128LE(bytes, seatStart + 72, 0n); // basePosition
    writeI128LE(bytes, seatStart + 88, 0n); // quoteEntryValue
    writeI128LE(bytes, seatStart + 104, 0n); // realizedPnl
    writeI128LE(bytes, seatStart + 120, 0n); // lastFundingAccumulator
    writeI128LE(bytes, seatStart + 136, 0n); // openBidExposure
    writeI128LE(bytes, seatStart + 152, 0n); // openAskExposure
    bytes.writeUInt32LE(0, seatStart + 168); // openOrderCount
    bytes[seatStart + 172] = 0; // liquidationState = Healthy
    bytes.writeBigUInt64LE(1n, seatStart + 176); // sequence
  }
  return bytes;
}

function v3CoreBytes() {
  const bytes = Buffer.alloc(4096);
  bytes.write("STKMK003");
  bytes.writeUInt16LE(3, 8);
  bytes[10] = 1;
  bytes[11] = 1;
  Buffer.alloc(32, 2).copy(bytes, 12);
  Buffer.alloc(32, 1).copy(bytes, 44);
  bytes[180] = 1;
  bytes.writeBigInt64LE(100n, 181);
  bytes.writeBigUInt64LE(1_000_000n, 189);
  bytes[197] = 0;
  bytes.writeBigUInt64LE(1n, 198);
  bytes.writeBigUInt64LE(1n, 206);
  bytes[371] = 2;
  bytes.writeUInt16LE(1_000, 1672);
  bytes.writeUInt16LE(500, 1674);
  bytes.writeUInt16LE(50, 1676);
  bytes.writeUInt16LE(2, 1678);
  bytes.writeUInt16LE(4, 1680);
  bytes.writeUInt32LE(10, 1682);
  bytes.writeUInt16LE(1_000, 304);
  bytes[370] = 0;
  bytes[371] = 2;
  bytes[372] = 0;
  return bytes;
}

function v3BookBytes(side, page) {
  const bytes = Buffer.alloc(10_184);
  bytes.write("STKBK003");
  bytes.writeUInt16LE(3, 8);
  bytes[10] = side;
  bytes[11] = page;
  v3CoreKey.toBuffer().copy(bytes, 12);
  return bytes;
}

function v3SeatBytes(shard) {
  const bytes = Buffer.alloc(8_236);
  bytes.write("STKST003");
  bytes.writeUInt16LE(3, 8);
  bytes[10] = shard;
  bytes[11] = 0;
  v3CoreKey.toBuffer().copy(bytes, 12);
  if (state.seatOccupied && shard === 0) {
    const base = 44;
    bytes[base] = 1;
    if (globalThis.__e2eOwnerBytes) globalThis.__e2eOwnerBytes.copy(bytes, base + 1);
    writeI128LE(bytes, base + 40, state.seatAvailableCollateral);
    bytes.writeBigUInt64LE(1n, base + 176);
  }
  return bytes;
}

function v3EventBytes(shard) {
  const bytes = Buffer.alloc(3_244);
  bytes.write("STKEV003");
  bytes.writeUInt16LE(3, 8);
  bytes[10] = shard;
  bytes[11] = 0;
  v3CoreKey.toBuffer().copy(bytes, 12);
  return bytes;
}

// sessionPda(base58) -> { owner: Buffer32, sessionSigner: Buffer32, market: Buffer32, revoked: boolean, actions }
const sessions = new Map();

function sessionBytes(entry) {
  const bytes = Buffer.alloc(256);
  bytes.write("STKSES02");
  bytes.writeUInt16LE(1, 8);
  bytes[10] = 1; // initialized
  bytes[11] = entry.revoked ? 1 : 0;
  entry.owner.copy(bytes, 12);
  entry.sessionSigner.copy(bytes, 44);
  Buffer.from(new Uint8Array(32).fill(3)).copy(bytes, 76); // targetProgram
  entry.market.copy(bytes, 108);
  bytes.writeUInt16LE(0, 140); // traderSeatIndex
  bytes.writeBigUInt64LE(1n, 142); // createdAt
  bytes.writeBigUInt64LE(9_999_999_999n, 150); // expiresAt (far future so isSessionUsable holds)
  bytes[158] = entry.actions;
  bytes.writeBigUInt64LE(1_000_000_000n, 159); // maxOrderNotional
  bytes.writeBigUInt64LE(10_000_000_000n, 167); // maxCumulativeNotional
  bytes.writeBigUInt64LE(0n, 175); // consumedCumulativeNotional
  writeI128LE(bytes, 183, 5_000_000_000n); // maxExposure
  bytes.writeUInt16LE(32, 199); // maxOpenOrders
  bytes.writeBigUInt64LE(0n, 201); // nextExpectedNonce
  bytes.writeBigUInt64LE(0n, 209); // lastActionTimestamp
  bytes.writeUInt32LE(1, 217); // sessionGeneration
  return bytes;
}

/** Decodes just enough of an incoming main-wallet transaction to react to
 * AuthorizeTradingSession/RevokeTradingSession the way the real program
 * would (register/mark the session PDA) -- everything else is accepted
 * unconditionally, matching this file's role as a functional-but-minimal
 * stand-in, not a full validator. */
function observeTransaction(base64) {
  let transaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch {
    return;
  }
  const keys = transaction.message.staticAccountKeys.map((key) => key.toBase58());
  const programIndex = keys.indexOf(PROGRAM_ID);
  if (programIndex === -1) return;
  for (const instruction of transaction.message.compiledInstructions) {
    if (instruction.programIdIndex !== programIndex) continue;
    const data = instruction.data;
    const discriminator = data[0];
    if (discriminator === AUTHORIZE_TRADING_SESSION) {
      // accounts: [market, payer, sessionPda, sessionSigner, systemProgram]
      const indexes = instruction.accountKeyIndexes.map((i) => keys[i]);
      // V3 authorization carries the full 27-account execution bundle before
      // authority/session/system accounts; V2 retains its five-account tuple.
      const [market, payer, sessionPda, sessionSigner] = indexes.length > 10
        ? [indexes[0], indexes[indexes.length - 4], indexes[indexes.length - 3], indexes[indexes.length - 2]]
        : indexes;
      sessions.set(sessionPda, {
        owner: publicKeyBytes(payer),
        sessionSigner: publicKeyBytes(sessionSigner),
        market: publicKeyBytes(market),
        revoked: false,
        actions: 0b11111,
      });
      globalThis.__e2eOwnerBytes = publicKeyBytes(payer);
    } else if (discriminator === REVOKE_TRADING_SESSION) {
      // accounts: [market, authority, session, sessionSigner]
      const sessionPda = keys[instruction.accountKeyIndexes[2]];
      const entry = sessions.get(sessionPda);
      if (entry) entry.revoked = true;
    }
  }
}

function publicKeyBytes(base58) {
  return Buffer.from(bs58Decode(base58));
}

function bs58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  let leadingZeros = 0;
  for (const char of value) { if (char === "1") leadingZeros += 1; else break; }
  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes]);
}

function fakeSignature() {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 88; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function jsonRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

const server = http.createServer((req, res) => {
  // Real Solana RPC endpoints send permissive CORS headers; the browser
  // calls this server directly (SolanaRpcTransport), and a plain Node
  // http server without these fails every request as "Failed to fetch"
  // (blocked preflight) despite the server working fine.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/control") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const command = JSON.parse(body);
      if (command.seatOccupied !== undefined) state.seatOccupied = command.seatOccupied;
      if (command.seatAvailableCollateral !== undefined) state.seatAvailableCollateral = BigInt(command.seatAvailableCollateral);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    const { id, method, params } = payload;
    res.writeHead(200, { "content-type": "application/json" });

    switch (method) {
      case "getLatestBlockhash":
        res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { blockhash: PROGRAM_ID, lastValidBlockHeight: 1_000_000 } }));
        return;
      case "getSlot":
        res.end(jsonRpcResult(id, 42));
        return;
      case "getBalance":
        res.end(jsonRpcResult(id, { context: { slot: 1 }, value: 5_000_000_000 }));
        return;
      case "getTokenAccountBalance":
        res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { amount: "1000000", decimals: 6, uiAmount: 1, uiAmountString: "1" } }));
        return;
      case "simulateTransaction":
        res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { err: null, unitsConsumed: 5000, logs: [] } }));
        return;
      case "sendTransaction": {
        const [base64] = params;
        observeTransaction(base64);
        res.end(jsonRpcResult(id, fakeSignature()));
        return;
      }
      case "getSignatureStatuses":
        res.end(jsonRpcResult(id, { context: { slot: 1 }, value: [{ err: null, confirmationStatus: "confirmed" }] }));
        return;
      case "getDelegationStatus":
        res.end(jsonRpcResult(id, { isDelegated: false }));
        return;
      case "getAccountInfo": {
        const [address] = params;
        const entry = sessions.get(address);
        if (entry) {
          res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { owner: PROGRAM_ID, executable: false, data: [sessionBytes(entry).toString("base64"), "base64"] } }));
          return;
        }
        const kind = v3Addresses.get(address);
        if (kind === "core") {
          res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { owner: PROGRAM_ID, executable: false, data: [v3CoreBytes().toString("base64"), "base64"] } }));
          return;
        }
        if (kind?.startsWith("book:")) {
          const [, side, page] = kind.split(":");
          res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { owner: PROGRAM_ID, executable: false, data: [v3BookBytes(Number(side), Number(page)).toString("base64"), "base64"] } }));
          return;
        }
        if (kind?.startsWith("seat:")) {
          res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { owner: PROGRAM_ID, executable: false, data: [v3SeatBytes(Number(kind.slice(5))).toString("base64"), "base64"] } }));
          return;
        }
        if (kind?.startsWith("event:")) {
          res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { owner: PROGRAM_ID, executable: false, data: [v3EventBytes(Number(kind.slice(6))).toString("base64"), "base64"] } }));
          return;
        }
        res.end(jsonRpcResult(id, { context: { slot: 1 }, value: { owner: PROGRAM_ID, executable: false, data: [marketBytes().toString("base64"), "base64"] } }));
        return;
      }
      default:
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `mock RPC: unimplemented method ${method}` } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`mock-rpc-server listening on ${PORT}`);
});
