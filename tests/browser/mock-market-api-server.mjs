// Minimal stand-in for the Worker's GET /v1/markets/:symbol/execution-status
// (workers/src/execution-status.ts) -- just enough for
// lib/execution-status.ts's useExecutionStatus to resolve to a real,
// withdrawal-safe status in tests, rather than staying permanently null
// (which the withdraw gate correctly treats as "unavailable").
import http from "node:http";

const PORT = Number(process.env.MOCK_MARKET_API_PORT ?? 4183);

// A test steers the returned execution status via POST /control before
// triggering the app action that will poll this server -- same pattern as
// mock-relayer-server.mjs's mode switch.
let status = "l1_only";
const WITHDRAWAL_SAFE = new Set(["l1_only", "commit_finalized", "restored"]);

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "POST" && req.url === "/control") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const command = JSON.parse(body);
      status = command.status ?? "l1_only";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status }));
    });
    return;
  }
  if (req.method === "GET" && /\/v1\/markets\/[^/]+\/execution-status$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status,
      sequences: {
        erEventSequence: 0,
        erMarketStateSequence: 0,
        requestedCommitSequence: 0,
        l1ObservedCommitSequence: 0,
        l1FinalizedCommitSequence: 0,
        undelegationSequence: 0,
        restorationSequence: 0,
      },
      error: status === "reconciliation_error" ? "mock reconciliation error" : null,
      withdrawalDisplaySafe: WITHDRAWAL_SAFE.has(status),
    }));
    return;
  }
  if (req.method === "GET" && /\/v1\/markets\/[^/]+\/snapshot$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`mock-market-api-server listening on ${PORT}`);
});
