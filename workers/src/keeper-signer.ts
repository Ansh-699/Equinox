/**
 * Secure production/devnet keeper signing: the startup boundary that binds
 * `KEEPER_KEYPAIR_JSON`-material (LOCAL_DEVNET mode) or future secret
 * bindings (CLOUDFLARE_FUTURE, deliberately not deployed in this phase) to
 * the role-separated `Signer` registry, with:
 *
 * - a **Devnet-only network guard**: a keeper signer is refused whenever
 *   the configured RPC endpoint is not a devnet/local endpoint, so a
 *   misconfigured deployment can never spend real funds with a keeper key;
 * - **public-key validation**: the loaded key material must derive exactly
 *   `KEEPER_PUBLIC_KEY` (a misconfigured or silently rotated secret is
 *   rejected at startup, not at signing time);
 * - **redacted errors**: no failure message anywhere in this module ever
 *   contains a byte of key material (see `signer.ts`'s redaction contract);
 * - **role separation**: the keeper signer may sign ONLY the keeper
 *   instruction families in `KEEPER_INSTRUCTION_ALLOWLIST` (Pyth consume,
 *   funding, session, cleanup, liquidation, commit/undelegate) plus the
 *   compute-budget/Ed25519/Pyth/Magic programs a keeper submission
 *   legitimately involves -- never a user transfer, never an unknown
 *   program, never market administration.
 *
 * Startup states (`KeeperSigningState`) are what the scheduler and the
 * `/v1/health/keepers` endpoint report:
 * - `observation-only`: no keeper material configured; discovery/reconciliation
 *   and health reporting run, nothing is ever submitted.
 * - `signer-ready`: material validated (pubkey matches, devnet guard ok);
 *   submission enabled.
 * - `signer-invalid`: material present but malformed, or it does not derive
 *   the configured public key; submission disabled, health reports the
 *   redacted reason.
 * - `configuration-blocked`: the network guard failed (a mainnet/unknown
 *   RPC endpoint is configured) -- submission refused regardless of key
 *   validity, per the release gate's "do not use mainnet" rule.
 */

import { getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction } from "@solana/kit";
import { STOCKSTREAM_PROGRAM_ID } from "../../clients/stockstream/src/constants";
import { LocalKeypairSigner, type Signer } from "./signer";

/** Program addresses that may appear in a keeper-signed transaction. */
export const KEEPER_ALLOWED_PROGRAMS: readonly string[] = [
  // StockStream itself (every keeper instruction family lives here).
  STOCKSTREAM_PROGRAM_ID,
  // Compute budget (the submission path prepends it).
  "ComputeBudget111111111111111111111111111111",
  // The Ed25519 native pre-instruction and the Pyth Pro Lazer oracle
  // program inside `consume_oracle_update`'s CPI.
  "Ed25519SigVerify111111111111111111111111111",
  "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt",
  // MagicBlock commit intents run against the Magic program + context.
  "Magic11111111111111111111111111111111111111",
  "MagicContext1111111111111111111111111111111",
];

const KEEPER_ALLOWED_PROGRAM_SET = new Set(KEEPER_ALLOWED_PROGRAMS);

const STOCKSTREAM_PROGRAM = STOCKSTREAM_PROGRAM_ID;
const MAGIC_PROGRAM = "Magic11111111111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** StockStream instruction opcodes a keeper signer may ever sign, by
 * family. Everything else (deposits, withdrawals, session authorization,
 * market administration, delegation lifecycle) is a main-wallet or market-
 * authority action and is never keeper-permitted. */
export const KEEPER_INSTRUCTION_ALLOWLIST: ReadonlySet<number> = new Set<number>([
  6 /* UpdateFunding */, 7 /* Liquidate */, 12 /* ConsumeOracleUpdate */,
  14 /* CommitMarket */, 15 /* CommitAndUndelegate */,
  31 /* UpdateTradingSessionLimits */, 32 /* CloseTradingSession */,
  38 /* ResolveBadDebt */, 39 /* ReconcileVault */,
]);

/** Opcode allowlist per allowed program (null = membership only). */
function opcodeAllowlistForProgram(program: string): ReadonlySet<number> | null {
  if (program === STOCKSTREAM_PROGRAM) return KEEPER_INSTRUCTION_ALLOWLIST;
  if (program === MAGIC_PROGRAM) {
    // ScheduleIntentBundle (bincode enum variant 11) is the only Magic
    // Program instruction the commit keeper invokes.
    return new Set([11]);
  }
  return null;
}

export interface KeeperTransactionAudit {
  ok: boolean;
  violations: readonly string[];
}

/** Audits a base64 wire transaction against the keeper allowlist BEFORE
 * submission: unknown programs, StockStream opcodes outside the allowlist,
 * and any explicit System-Program lamport movement (fee-payer drain
 * attempts) are violations. Never throws; never logs transaction bytes. */
export function auditKeeperTransaction(base64WireTransaction: string): KeeperTransactionAudit {
  const violations: string[] = [];
  let instructions: readonly { programAddress: string; data?: Readonly<Uint8Array> }[];
  try {
    const wireBytes = Uint8Array.from(atob(base64WireTransaction), (c) => c.charCodeAt(0));
    const { messageBytes } = getTransactionDecoder().decode(wireBytes);
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const staticKeys = message.staticAccounts;
    instructions = message.instructions.map((compiled) => ({
      programAddress: staticKeys[compiled.programAddressIndex]!.toString(),
      data: compiled.data ? Uint8Array.from(compiled.data) : undefined,
    }));
  } catch {
    return { ok: false, violations: ["transaction does not decode"] };
  }
  instructions.forEach((instruction, index) => {
    const program = String(instruction.programAddress ?? "");
    if (!KEEPER_ALLOWED_PROGRAM_SET.has(program)) {
      violations.push(`instruction ${index}: program ${program} is not keeper-approved`);
      return;
    }
    if (program === SYSTEM_PROGRAM) {
      // Any explicit system-program instruction would move the fee payer's
      // lamports: a drain attempt. The runtime's own fee accounting is not
      // an instruction and is unaffected.
      violations.push(`instruction ${index}: explicit system-program instruction in a keeper transaction`);
      return;
    }
    const opcodes = opcodeAllowlistForProgram(program);
    if (opcodes && instruction.data && instruction.data.length > 0 && !opcodes.has(instruction.data[0])) {
      violations.push(`instruction ${index}: opcode ${instruction.data[0]} is not keeper-permitted for ${program}`);
    }
  });
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------
// Startup state machine
// ---------------------------------------------------------------------

export type KeeperSigningState = "observation-only" | "signer-ready" | "signer-invalid" | "configuration-blocked";

export interface KeeperSigningResolution {
  state: KeeperSigningState;
  /** Redacted reason; safe for logs. Never contains key material. */
  detail: string;
  /** Only non-null in the `signer-ready` state. */
  signer: Signer | null;
  keyId: string | null;
}

const DEVNET_MARKERS = ["devnet", "localhost", "127.0.0.1"];

/** Devnet-only network guard: refuses to bind a keeper signer against any
 * endpoint that is not explicitly a devnet/local one. Mainnet URLs (or
 * anything unrecognizable) block configuration. */
export function isDevnetOnlyEndpoint(rpcUrl: string | undefined): boolean {
  if (!rpcUrl) return false;
  const lower = rpcUrl.toLowerCase();
  if (lower.includes("mainnet")) return false;
  return DEVNET_MARKERS.some((marker) => lower.includes(marker));
}

function parsePublicKeyHex(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Minimal base58 decode (Bitcoin alphabet, Solana-compatible). */
export function base58Decode(value: string): Uint8Array | null {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes: number[] = [0];
  for (const char of value) {
    const carry = ALPHABET.indexOf(char);
    if (carry < 0) return null;
    let temp = carry;
    for (let i = 0; i < bytes.length; i += 1) {
      temp += bytes[i] * 58;
      bytes[i] = temp & 0xff;
      temp >>= 8;
    }
    while (temp > 0) {
      bytes.push(temp & 0xff);
      temp >>= 8;
    }
  }
  return Uint8Array.from(bytes.reverse());
}

function parsePublicKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return parsePublicKeyHex(trimmed);
  const decoded = base58Decode(trimmed);
  if (!decoded || decoded.length !== 32) {
    throw new Error("KEEPER_PUBLIC_KEY must be a 32-byte Solana address");
  }
  return decoded;
}

export interface KeeperSigningEnv {
  KEEPER_KEYPAIR_JSON?: string;
  KEEPER_PUBLIC_KEY?: string;
  SOLANA_RPC_URL?: string;
}

/** Resolves the LOCAL_DEVNET keeper signing boundary from the environment.
 *
 * Inputs (all optional; presence decides the state):
 * - `KEEPER_KEYPAIR_JSON`: a Solana-CLI-style JSON keypair (32- or 64-byte
 *   array) -- supplied by untracked local storage (`.dev.vars`/shell env),
 *   never committed, never logged;
 * - `KEEPER_PUBLIC_KEY`: the expected Solana address -- validated against
 *   the derived key so a stale/rotated mismatch blocks startup instead of
 *   signing with the wrong identity.
 */
export async function resolveKeeperSigning(env: KeeperSigningEnv): Promise<KeeperSigningResolution> {
  // Network guard first: even valid material is refused on a non-devnet
  // endpoint (mainnet is excluded from this phase by the release gate).
  if (!isDevnetOnlyEndpoint(env.SOLANA_RPC_URL)) {
    return {
      keyId: null,
      state: "configuration-blocked",
      detail: env.SOLANA_RPC_URL
        ? "SOLANA_RPC_URL is not a recognized devnet endpoint; keeper signing disabled (devnet-only guard)"
        : "SOLANA_RPC_URL is not configured; keeper signing disabled",
      signer: null,
    };
  }
  if (!env.KEEPER_KEYPAIR_JSON) {
    return { state: "observation-only", keyId: null, detail: "no keeper key material configured; discovery/observation only", signer: null };
  }
  if (!env.KEEPER_PUBLIC_KEY) {
    return {
      state: "signer-invalid",
      keyId: null,
      detail: "KEEPER_PUBLIC_KEY is not configured to validate the loaded key material",
      signer: null,
    };
  }
  const signer = new LocalKeypairSigner("keeper:local-devnet", env.KEEPER_KEYPAIR_JSON);
  const health = await signer.health();
  if (!health.ok) {
    return {
      state: "signer-invalid",
      keyId: null,
      detail: "keeper key material rejected (redacted; malformed or wrong length)",
      signer: null,
    };
  }
  // Public-key validation: the loaded material must derive exactly the
  // configured keeper public key. Neither key is ever logged.
  const derived = await signer.publicKey();
  const expected = parsePublicKey(env.KEEPER_PUBLIC_KEY);
  const mismatch =
    expected.length !== derived.length ||
    expected.some((byte, index) => byte !== derived[index]);
  if (mismatch) {
    return {
      state: "signer-invalid",
      keyId: null,
      detail: "keeper key material does not derive KEEPER_PUBLIC_KEY (redacted; both keys withheld from logs)",
      signer: null,
    };
  }
  return { state: "signer-ready", detail: "keeper signer ready (local devnet material, validated)", signer, keyId: "keeper:local-devnet" };
}
