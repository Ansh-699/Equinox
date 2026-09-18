// Minimal stand-in for the Worker's GET /v1/markets/:symbol/execution-status
// AND GET/WS /v1/markets/:symbol/stream (workers/src/execution-status.ts,
// market-stream.ts) -- just enough for lib/execution-status.ts's
// useExecutionStatus and features/activity/use-market-events.ts's
// WebSocket consumer to see real, controllable data in tests, rather than
// staying permanently null/empty.
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_MARKET_API_PORT ?? 4183);

// A test steers the returned execution status, or pushes a synthetic
// market event to every connected stream socket, via POST /control --
// same pattern as mock-relayer-server.mjs's mode switch.
let status = "l1_only";
let streamDown = false; // simulates the WS endpoint being unreachable, for reconnect-exhaustion tests
const WITHDRAWAL_SAFE = new Set(["l1_only", "commit_finalized", "restored"]);
const streamSockets = new Set();

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "POST" && req.url === "/control") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const command = JSON.parse(body);
      if (command.status) status = command.status;
      if (typeof command.streamDown === "boolean") {
        streamDown = command.streamDown;
        if (streamDown) for (const socket of streamSockets) socket.close();
      }
      if (command.pushEvent) {
        const payload = JSON.stringify(command.pushEvent);
        for (const socket of streamSockets) socket.send(payload);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status, streamDown, connectedSockets: streamSockets.size }));
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

// Real WS upgrade for /v1/markets/:symbol/stream -- a browser-side consumer
// (useMarketEvents, trading-terminal.tsx) connects once per page and stays
// connected; a test pushes events into it via POST /control's `pushEvent`.
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket) => {
  streamSockets.add(socket);
  socket.on("close", () => streamSockets.delete(socket));
});
server.on("upgrade", (req, socket, head) => {
  if (streamDown || !/\/v1\/markets\/[^/]+\/stream$/.test(req.url ?? "")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

server.listen(PORT, () => {
  console.log(`mock-market-api-server listening on ${PORT}`);
});
