import { describe, expect, it } from "vitest";
import {
  createProductionSigner,
  DeterministicTestSigner,
  LocalKeypairSigner,
  MockSigner,
  SignerRegistry,
  type SignerRole,
} from "./signer";

describe("DeterministicTestSigner", () => {
  it("produces a stable 32-byte public key across instances with the same keyId", async () => {
    const a = new DeterministicTestSigner("pyth-test");
    const b = new DeterministicTestSigner("pyth-test");
    expect(await a.publicKey()).toEqual(await b.publicKey());
    expect((await a.publicKey()).length).toBe(32);
  });

  it("gives different roles different keys", async () => {
    const a = new DeterministicTestSigner("pyth-test");
    const b = new DeterministicTestSigner("commit-test");
    expect(await a.publicKey()).not.toEqual(await b.publicKey());
  });

  it("produces a real, independently verifiable Ed25519 signature", async () => {
    const signer = new DeterministicTestSigner("verify-test");
    const message = new TextEncoder().encode("stockstream keeper transaction");
    const signature = await signer.sign(message);
    expect(signature.length).toBe(64);
    const publicKey = await signer.publicKey();
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", key, signature, message)).toBe(true);
    expect(await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode("tampered"))).toBe(false);
  });

  it("reports healthy without ever exposing key material", async () => {
    const signer = new DeterministicTestSigner("health-test");
    expect(await signer.health()).toEqual({ ok: true });
    expect(Object.keys(signer)).not.toContain("privateKey");
  });
});

describe("LocalKeypairSigner", () => {
  it("derives the same key from a 64-byte Solana-CLI-style JSON array and its 32-byte seed prefix", async () => {
    const seed = Array.from({ length: 32 }, (_, i) => i + 1);
    const fakePubkeySuffix = Array.from({ length: 32 }, () => 0);
    const fromArray = new LocalKeypairSigner("local-a", JSON.stringify([...seed, ...fakePubkeySuffix]));
    const fromSeedOnly = new LocalKeypairSigner("local-b", JSON.stringify(seed));
    expect(await fromArray.publicKey()).toEqual(await fromSeedOnly.publicKey());
  });

  it("derives a key from a base64-encoded 32-byte seed", async () => {
    const seedBytes = new Uint8Array(32).fill(9);
    let binary = "";
    for (const b of seedBytes) binary += String.fromCharCode(b);
    const signer = new LocalKeypairSigner("local-b64", btoa(binary));
    expect((await signer.publicKey()).length).toBe(32);
  });

  it("rejects a malformed keypair source instead of silently producing a wrong key", async () => {
    const signer = new LocalKeypairSigner("bad", JSON.stringify([1, 2, 3]));
    await expect(signer.publicKey()).rejects.toThrow(/32 or 64 bytes/);
    expect((await signer.health()).ok).toBe(false);
  });
});

describe("MockSigner", () => {
  it("never performs real cryptography and is always healthy", async () => {
    const signer = new MockSigner("mock-role");
    expect((await signer.publicKey()).length).toBe(32);
    expect((await signer.sign(new Uint8Array([1, 2, 3]))).length).toBe(64);
    expect(await signer.health()).toEqual({ ok: true });
  });
});

describe("createProductionSigner", () => {
  it("refuses to fabricate a production signer without real key infrastructure", () => {
    expect(() => createProductionSigner("liquidation")).toThrow(/not implemented/);
  });
});

describe("SignerRegistry", () => {
  const roles: SignerRole[] = ["pyth", "magicblock-commit", "funding", "market-session", "expiry-cleanup", "liquidation"];

  function registry(): SignerRegistry {
    const signers = Object.fromEntries(roles.map((role) => [role, new DeterministicTestSigner(role)])) as Record<
      SignerRole,
      DeterministicTestSigner
    >;
    return new SignerRegistry(signers);
  }

  it("returns a distinct signer per role", async () => {
    const reg = registry();
    const pythKey = await reg.for("pyth").publicKey();
    const commitKey = await reg.for("magicblock-commit").publicKey();
    expect(pythKey).not.toEqual(commitKey);
  });

  it("reports health for every role independently", async () => {
    const reg = registry();
    const health = await reg.healthAll();
    for (const role of roles) expect(health[role]).toEqual({ ok: true });
  });
});
