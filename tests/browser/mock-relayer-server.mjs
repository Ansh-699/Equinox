// Stands in for the Worker's POST /v1/relay/session
// (workers/src/index.ts / session-relayer.ts) so E2E tests can exercise
// app/api/relay/session/route.ts's own auth/forwarding logic without a
// live Worker deployment. A test steers behavior via POST /control before
// triggering the app action that will call this server.
import http from "node:http";

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
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
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
      const parsed = JSON.parse(body); // this mock does not decode the transaction itself, but DOES enforce strict nonce progression on the forwarded expectedNonce, exactly like the real program's SessionNonceReplay check
      const nonce = BigInt(parsed.expectedNonce ?? "0");
      if (expectedNonce !== null && nonce !== expectedNonce) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `session nonce replay: expected ${expectedNonce}, got ${nonce}` }));
        return;
      }
      expectedNonce = nonce + 1n;
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, signature: fakeSignature() }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`mock-relayer-server listening on ${PORT}`);
});
