import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { consumeOracleUpdate } from "../../clients/stockstream/src";
import { OracleTracker, requirePythServerConfig, type OracleUpdate } from "../oracle";

const ED25519_PROGRAM = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const MAX_RETRIES = 3;

export interface SignedPythUpdate extends OracleUpdate {
  payload: Uint8Array;
  signature: Uint8Array;
  publicKey: Uint8Array;
  payloadHash: string;
}
export interface PythKeeperConfig { apiKey: string; feedId: string; endpoints: readonly string[]; accounts: { market: string; pythProgram: string; storage: string; treasury: string; instructionsSysvar: string; payload: string }; }
export interface KeeperFetch { (input: string, init?: RequestInit): Promise<Response>; }

function bytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, "");
  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length % 2 === 0) return Uint8Array.from(normalized.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
  return Uint8Array.from(Buffer.from(value, "base64"));
}
function hex(data: Uint8Array): string { return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join(""); }

export function loadPythKeeperConfig(env: Record<string, string | undefined>): PythKeeperConfig {
  const base = requirePythServerConfig(env);
  const endpoints = (env.PYTH_PRO_ENDPOINTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!endpoints.length) throw new Error("PYTH_PRO_ENDPOINTS is required for live keeper operation");
  const required = ["STOCKSTREAM_MARKET_ADDRESS", "PYTH_PROGRAM_ADDRESS", "PYTH_STORAGE_ADDRESS", "PYTH_TREASURY_ADDRESS", "PYTH_PAYLOAD_ADDRESS"] as const;
  for (const key of required) if (!env[key]) throw new Error(`${key} is required for keeper transaction construction`);
  return { apiKey: base.apiKey, feedId: base.feedId, endpoints, accounts: { market: env.STOCKSTREAM_MARKET_ADDRESS!, pythProgram: env.PYTH_PROGRAM_ADDRESS!, storage: env.PYTH_STORAGE_ADDRESS!, treasury: env.PYTH_TREASURY_ADDRESS!, instructionsSysvar: "Sysvar1nstructions1111111111111111111111111", payload: env.PYTH_PAYLOAD_ADDRESS! } };
}

function ed25519Instruction(update: SignedPythUpdate): TransactionInstruction {
  if (update.signature.length !== 64 || update.publicKey.length !== 32) throw new Error("invalid Ed25519 update framing");
  const offsets = new Uint8Array(14); const view = new DataView(offsets.buffer);
  view.setUint16(0, 2 + 14, true); view.setUint16(2, 0xffff, true); view.setUint16(4, 2 + 14 + 64, true); view.setUint16(6, 0xffff, true); view.setUint16(8, 2 + 14 + 64 + 32, true); view.setUint16(10, 0xffff, true); view.setUint16(12, update.payload.length, true);
  const data = new Uint8Array(2 + offsets.length + update.signature.length + update.publicKey.length + update.payload.length); data[0] = 1; data.set(offsets, 2); data.set(update.signature, 16); data.set(update.publicKey, 80); data.set(update.payload, 112);
  return new TransactionInstruction({ programId: ED25519_PROGRAM, keys: [], data: Buffer.from(data) });
}

export class PythKeeper {
  private readonly tracker: OracleTracker;
  private lastTimestamp = 0;
  private lastPayloadHash = "";
  constructor(private readonly config: PythKeeperConfig, private readonly fetcher: KeeperFetch = fetch, private readonly now: () => number = Date.now) {
    this.tracker = new OracleTracker({ feedId: config.feedId, channel: "fixed_rate@200ms", maxAgeMs: 10_000, maxConfidence: 5n, exponent: -2 });
  }
  async fetchSignedUpdate(): Promise<SignedPythUpdate> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const endpoint = this.config.endpoints[attempt % this.config.endpoints.length];
      try {
        const response = await this.fetcher(endpoint, { method: "POST", headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ feedId: this.config.feedId, channel: "fixed_rate@200ms", format: "solana" }) });
        if (!response.ok) throw new Error(`Pyth Pro response ${response.status}`);
        const body = await response.json() as Record<string, unknown>;
        const payload = bytes(String(body.payload ?? "")); const signature = bytes(String(body.signature ?? "")); const publicKey = bytes(String(body.publicKey ?? ""));
        const update: SignedPythUpdate = { feedId: String(body.feedId), channel: String(body.channel), price: BigInt(String(body.price)), exponent: Number(body.exponent), confidence: BigInt(String(body.confidence)), timestamp: Number(body.timestamp), session: body.session as OracleUpdate["session"], status: body.status as OracleUpdate["status"], payload, signature, publicKey, payloadHash: hex(payload) };
        if (update.timestamp <= this.lastTimestamp || update.payloadHash === this.lastPayloadHash) throw new Error("duplicate or older Pyth update");
        this.tracker.accept(update, this.now());
        this.lastTimestamp = update.timestamp; this.lastPayloadHash = update.payloadHash;
        return update;
      } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50)); }
    }
    throw lastError instanceof Error ? lastError : new Error("Pyth Pro update unavailable");
  }
  buildTransaction(update: SignedPythUpdate): TransactionInstruction[] {
    if (update.feedId !== this.config.feedId) throw new Error("unexpected Pyth feed");
    const ed25519 = ed25519Instruction(update);
    const consumer = consumeOracleUpdate({ ...this.config.accounts });
    return [ed25519, consumer];
  }
  get health() { return { configured: true, feedIdConfigured: Boolean(this.config.feedId), lastTimestamp: this.lastTimestamp, lastPayloadHash: this.lastPayloadHash }; }
}

export function pythHealth(env: Record<string, string | undefined>) {
  return { configured: Boolean(env.PYTH_PRO_API_KEY && env.PYTH_PRO_FEED_ID), liveVerification: Boolean(env.PYTH_PRO_API_KEY), feedIdConfigured: Boolean(env.PYTH_PRO_FEED_ID) };
}
