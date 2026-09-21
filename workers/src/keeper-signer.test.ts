/**
 * Secure keeper signing boundary tests (LOCAL_DEVNET mode):
 * correct/wrong/missing key material, public-key validation, the
 * Devnet-only network guard, redacted errors, and the keeper transaction
 * instruction allowlist (no user transfers, no unknown programs, no
 * fee-payer drains, no out-of-role instructions).
 */

import { expect, test } from "vitest";
import {
  address,
  AccountRole,
  getBase58Decoder,
  type Instruction,
} from "@solana/kit";
import {
  auditKeeperTransaction,
  base58Decode,
  isDevnetOnlyEndpoint,
  resolveKeeperSigning,
  type KeeperSigningEnv,
} from "./keeper-signer";
import { LocalKeypairSigner } from "./signer";
import { signAndSerializeTransaction } from "./transactions";

const STOCKSTREAM_PROGRAM = "BY81jGEfzwuqGkJbyYaGBty5Pn6oZLfntYUFkV85XZfo";

/** A fresh Solana-CLI-style JSON keypair per test. */
function keypairMaterial(): string {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return JSON.stringify([...seed, ...new Uint8Array(32)]);
}

test("devnet-only network guard", () => {
  expect(isDevnetOnlyEndpoint("https://api.devnet.solana.com")).toBe(true);
  expect(isDevnetOnlyEndpoint("http://localhost:8899")).toBe(true);
  expect(isDevnetOnlyEndpoint("http://127.0.0.1:8899")).toBe(true);
  expect(isDevnetOnlyEndpoint("https://api.mainnet-beta.solana.com")).toBe(false);
  expect(isDevnetOnlyEndpoint("https://some-unrecognized-rpc.example.com")).toBe(false);
  expect(isDevnetOnlyEndpoint(undefined)).toBe(false);
});

test("correct keeper material binds as signer-ready", async () => {
  const material = keypairMaterial();
  const signer = new LocalKeypairSigner("keeper:local-devnet", material);
  const env: KeeperSigningEnv = {
    KEEPER_KEYPAIR_JSON: material,
    KEEPER_PUBLIC_KEY: getBase58Decoder().decode(await signer.publicKey()),
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
  };
  const resolution = await resolveKeeperSigning(env);
  expect(resolution.state).toBe("signer-ready");
  expect(resolution.signer).not.toBeNull();
  expect(Array.from(await resolution.signer!.publicKey())).toEqual(Array.from(await signer.publicKey()));
});

test("wrong keeper public key -> signer-invalid with redacted detail", async () => {
  const env: KeeperSigningEnv = {
    KEEPER_KEYPAIR_JSON: keypairMaterial(),
    KEEPER_PUBLIC_KEY: "4DzWpPLFKaBA64uyzvjVzRxQsqUEDeJ78kmpBGfwGuQx",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
  };
  const resolution = await resolveKeeperSigning(env);
  expect(resolution.state).toBe("signer-invalid");
  // Redaction: neither the derived key nor the expected one appears in the
  // failure detail.
  expect(resolution.detail).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{40,}/);
  expect(resolution.detail).toMatch(/redacted/i);
  expect(resolution.signer).toBeNull();
});

test("malformed key material -> signer-invalid without leaking bytes", async () => {
  const env: KeeperSigningEnv = {
    KEEPER_KEYPAIR_JSON: "[1,2,3]",
    KEEPER_PUBLIC_KEY: "4DzWpPLFKaBA64uyzvjVzRxQsqUEDeJ78kmpBGfwGuQx",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
  };
  const resolution = await resolveKeeperSigning(env);
  expect(resolution.state).toBe("signer-invalid");
  expect(resolution.detail).not.toContain("1,2,3");
  expect(resolution.signer).toBeNull();
});

test("no keeper material configured -> observation-only", async () => {
  const resolution = await resolveKeeperSigning({
    KEEPER_PUBLIC_KEY: "4DzWpPLFKaBA64uyzvjVzRxQsqUEDeJ78kmpBGfwGuQx",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
  });
  expect(resolution.state).toBe("observation-only");
  expect(resolution.signer).toBeNull();
});

test("mainnet endpoint blocks configuration even with valid material", async () => {
  const resolution = await resolveKeeperSigning({
    KEEPER_KEYPAIR_JSON: keypairMaterial(),
    KEEPER_PUBLIC_KEY: "4DzWpPLFKaBA64uyzvjVzRxQsqUEDeJ78kmpBGfwGuQx",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
  });
  expect(resolution.state).toBe("configuration-blocked");
  expect(resolution.signer).toBeNull();
});

test("missing KEEPER_PUBLIC_KEY alongside material -> signer-invalid", async () => {
  const resolution = await resolveKeeperSigning({
    KEEPER_KEYPAIR_JSON: JSON.stringify([...new Uint8Array(32), ...new Uint8Array(32)]),
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
  });
  expect(resolution.state).toBe("signer-invalid");
  expect(resolution.signer).toBeNull();
});

test("base58Decode matches @solana/kit's decoder", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = getBase58Decoder().decode(bytes);
  const decoded = base58Decode(encoded);
  expect(decoded).not.toBeNull();
  expect(Array.from(decoded!)).toEqual(Array.from(bytes));
});

// ---------------------------------------------------------------------
// Keeper transaction allowlist: the signer boundary rejects anything a
// keeper must never be able to submit.
// ---------------------------------------------------------------------

test("an allowlisted StockStream keeper instruction passes the audit", async () => {
  // ReconcileVault (opcode 39) is a keeper family instruction.
  const signer = new LocalKeypairSigner("keeper:local-devnet", keypairMaterial());
    const keeperAddr = getBase58Decoder().decode(await signer.publicKey());
  const market = address("91Wxz2Nn4yvtjHEoYrDSMfyZYG86twVEMnCBwCZFFZE");
  const vault = address("sZ53hm8F9bJADXMUzbTJNUwFqDvdnThdytro4agPq3F");
  const reconcileInstruction = {
    programAddress: address(STOCKSTREAM_PROGRAM),
    accounts: [
      { address: market, role: AccountRole.WRITABLE },
      { address: keeperAddr, role: AccountRole.READONLY_SIGNER },
      { address: vault, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([39]),
  } as never as Instruction;
  const wire = await signAndSerializeTransaction({
    instructions: [reconcileInstruction],
    signer,
    recentBlockhash: "11111111111111111111111111111111",
  });
  const audit = auditKeeperTransaction(wire);
  expect(audit.ok).toBe(true);
  expect(audit.violations).toHaveLength(0);
});

test("keeper cannot submit a market-administration instruction (UpdateExchangeConfig, opcode 40)", async () => {
  const signer = new LocalKeypairSigner("keeper:local-devnet", keypairMaterial());
  const exchange = address("CnWpbUPUEiuXwZo8Hon9ukkNSyJKnxxh3KSqRPDHxNqs");
  const administrationInstruction = {
    programAddress: address(STOCKSTREAM_PROGRAM),
    accounts: [
      { address: exchange, role: AccountRole.WRITABLE },
      { address: exchange, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([40]),
  } as never as Instruction;
  const wire = await signAndSerializeTransaction({
    instructions: [administrationInstruction],
    signer,
    recentBlockhash: "11111111111111111111111111111111",
  });
  const audit = auditKeeperTransaction(wire);
  expect(audit.ok).toBe(false);
  expect(audit.violations.join("\n")).toMatch(/opcode 40 is not keeper-permitted/);
});

test("keeper cannot carry an explicit system-program lamport transfer (fee-payer drain)", async () => {
  const signer = new LocalKeypairSigner("keeper:local-devnet", keypairMaterial());
  const keeperAddr = getBase58Decoder().decode(await signer.publicKey());
  const destination = address("5qYN1Y638bt17TBQrB9rPGsNkL2cEeie4Luv4qZtoNgr");
  const transferInstruction = {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: keeperAddr, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), // SystemProgram::Transfer(1 lamport)
  } as never as Instruction;
  const wire = await signAndSerializeTransaction({
    instructions: [transferInstruction],
    signer,
    recentBlockhash: "11111111111111111111111111111111",
  });
  const audit = auditKeeperTransaction(wire);
  expect(audit.ok).toBe(false);
  expect(audit.violations.join("\n")).toMatch(/11111111111111111111111111111111/);
});

test("keeper cannot submit an unknown program", async () => {
  const signer = new LocalKeypairSigner("keeper:local-devnet", keypairMaterial());
  const rogue = {
    programAddress: address("A1RM7So6JyVhrSncroxxoCBSDKmvmqQEEwiRUDLKKxZE"),
    accounts: [],
    data: new Uint8Array([0]),
  } as never as Instruction;
  const wire = await signAndSerializeTransaction({
    instructions: [rogue],
    signer,
    recentBlockhash: "11111111111111111111111111111111",
  });
  const audit = auditKeeperTransaction(wire);
  expect(audit.ok).toBe(false);
  expect(audit.violations.join("\n")).toMatch(/not keeper-approved/);
});
