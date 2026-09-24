#!/usr/bin/env node
/**
 * Read-only MagicBlock/Pyth compatibility probe.
 *
 * This script derives the configured Pyth Lazer account, reads it from L1 and
 * ER, and observes a few ER WebSocket updates. It never signs, submits, or
 * allocates an account. A live MagicBlock price account is not treated as a
 * Equinox OracleSnapshotV3 unless the manifest contains a reviewed bridge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "config", "equinox-deployment.json"), "utf8"));
const ORACLE_PROGRAM = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const [feedPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("price_feed"), Buffer.from("pyth-lazer"), Buffer.from(String(manifest.oracle.feedId))],
  ORACLE_PROGRAM,
);
const L1 = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ER = manifest.magicBlock.rpc;

async function accountInfo(endpoint) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [feedPda.toBase58(), { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const body = await response.json();
  const value = body.result?.value;
  return {
    endpoint,
    slot: body.result?.context?.slot ?? null,
    exists: Boolean(value),
    owner: value?.owner ?? null,
    dataLength: value?.data?.[0] ? Buffer.from(value.data[0], "base64").length : 0,
    error: body.error?.message ?? null,
  };
}

function observeErUpdates(limit = 3, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const updates = [];
    const socket = new WebSocket(ER.replace(/^https:/, "wss:"));
    const timer = setTimeout(() => {
      socket.close();
      resolve(updates);
    }, timeoutMs);
    socket.on("open", () => socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "accountSubscribe",
      params: [feedPda.toBase58(), { encoding: "base64", commitment: "confirmed" }],
    })));
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.method !== "accountNotification") return;
        const value = message.params?.result?.value;
        if (!value?.data?.[0]) return;
        const bytes = Buffer.from(value.data[0], "base64");
        updates.push({
          slot: message.params.result.context.slot,
          owner: value.owner,
          dataLength: bytes.length,
          verificationLevel: bytes.length > 40 ? bytes[40] : null,
          exponent: bytes.length >= 93 ? bytes.readInt32LE(89) : null,
          confidence: bytes.length >= 89 ? bytes.readBigUInt64LE(81).toString() : null,
          priceRaw: bytes.length >= 81 ? bytes.readBigInt64LE(73).toString() : null,
          publishTime: bytes.length >= 101 ? bytes.readBigInt64LE(93).toString() : null,
          postedSlot: bytes.length >= 133 ? bytes.readBigUInt64LE(125).toString() : null,
        });
        if (updates.length >= limit) {
          clearTimeout(timer);
          socket.close();
          resolve(updates);
        }
      } catch {
        // Ignore malformed notifications; the probe remains read-only.
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(updates);
    });
  });
}

const [l1, er] = await Promise.all([accountInfo(L1), accountInfo(ER)]);
const updates = await observeErUpdates();
console.log(JSON.stringify({
  readOnly: true,
  feedId: manifest.oracle.feedId,
  feedPda: feedPda.toBase58(),
  oracleProgram: ORACLE_PROGRAM.toBase58(),
  l1,
  er,
  erWebSocketUpdates: updates,
  equinoxSnapshotConfigured: manifest.oracleSnapshot !== null,
  equinoxSnapshotCompatibility: false,
  reason: "MagicBlock's price account is not a substitute for the authenticated Equinox OracleSnapshotV3 schema.",
}, null, 2));
