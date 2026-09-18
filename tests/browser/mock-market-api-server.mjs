// Minimal stand-in for the Worker's GET /v1/markets/:symbol/execution-status
// (workers/src/execution-status.ts) -- just enough for
// lib/execution-status.ts's useExecutionStatus to resolve to a real,
// withdrawal-safe status in tests, rather than staying permanently null
// (which the withdraw gate correctly treats as "unavailable").
import http from "node:http";

const PORT = Number(process.env.MOCK_MARKET_API_PORT ?? 4183);

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET" && /\/v1\/markets\/[^/]+\/execution-status$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "l1_only",
      sequences: {
        erEventSequence: 0,
        erMarketStateSequence: 0,
        requestedCommitSequence: 0,
        l1ObservedCommitSequence: 0,
        l1FinalizedCommitSequence: 0,
        undelegationSequence: 0,
        restorationSequence: 0,
      },
      error: null,
      withdrawalDisplaySafe: true,
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
