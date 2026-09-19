// Stands in for the Worker's POST /v1/relay/session
// (workers/src/index.ts / session-relayer.ts) so E2E tests can exercise
// app/api/relay/session/route.ts's own auth/forwarding logic without a
// live Worker deployment. A test steers behavior via POST /control before
// triggering the app action that will call this server.
import http from "node:http";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";

const PORT = Number(process.env.MOCK_RELAYER_PORT ?? 4182);
const EXPECTED_TOKEN = process.env.MOCK_RELAYER_TOKEN ?? "mock-relayer-token";

let mode = "success"; // success | signer_unconfigured | reject | down
let expectedNonce = null; // first request seeds it; every next one must be exactly +1

function fakeSignature() {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 88; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/control") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const command = JSON.parse(body);
      mode = command.mode ?? "success";
      if (command.resetNonce) expectedNonce = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/relay/session") {
    if (mode === "down") {
      req.destroy();
      return;
    }
    // Two independent headers, matching the real proxy's contract
    // (app/api/relay/session/route.ts): a static service-to-service token
    // proving "a legitimate backend" (this test's EXPECTED_TOKEN), and a
    // per-user Authorization bearer carrying the user's own (real or, in
    // e2e test mode, sentinel) Privy access token -- this mock only cares
    // that the latter is present, not its specific value, since verifying
    // Privy identity is the real Worker's job, not this relay-behavior mock's.
    const serviceToken = req.headers["x-stockstream-relayer-service-token"];
    const auth = req.headers.authorization;
    if (serviceToken !== EXPECTED_TOKEN || !auth?.startsWith("Bearer ")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (mode === "signer_unconfigured") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "relayer_signer_unconfigured" }));
        return;
      }
      if (mode === "reject") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "opcode 99 is not allowed for a session-signed transaction" }));
        return;
      }
      // The real Worker no longer trusts a client-asserted "expectedNonce"
      // field (it extracts the nonce from the signed instruction's own
      // bytes -- session-relayer.ts); this mock does the same, decoding
      // the real (v0/versioned) transaction and reading its single
      // instruction's last 8 bytes (every session-relayable opcode's
      // actionNonce field), so this still faithfully exercises the
      // frontend's own nonce bookkeeping (session-trading.ts) rather than
      // a side-channel claim. A decode failure must return an error
      // response, never crash this process and take the rest of the
      // suite's requests down with it.
      try {
        const parsed = JSON.parse(body);
        const wireBytes = Buffer.from(parsed.transactionBase64, "base64");
        const transaction = getTransactionDecoder().decode(wireBytes);
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        const data = Buffer.from(compiled.instructions[0].data);
        const nonce = data.readBigUInt64LE(data.length - 8);
        if (expectedNonce !== null && nonce !== expectedNonce) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `session nonce replay: expected ${expectedNonce}, got ${nonce}` }));
          return;
        }
        expectedNonce = nonce + 1n;
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true, signature: fakeSignature() }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `malformed transaction: ${err instanceof Error ? err.message : String(err)}` }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`mock-relayer-server listening on ${PORT}`);
});
