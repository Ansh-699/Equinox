import { describe, expect, it } from "vitest";
import {
  createProductionSigner,
  DeterministicTestSigner,
  LocalKeypairSigner,
  MockSigner,
  RemoteSigner,
  SecretBackedSigner,
  SignerRegistry,
  type ProductionSignerSecret,
  type RemoteSignerTransport,
  type SignerRole,
} from "./signer";

const PKCS8_ED25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function realKeypair(): Promise<{ seed: Uint8Array; publicKey: Uint8Array }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8.buffer, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pub)) as ArrayBuffer);
  return { seed, publicKey };
}

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

describe("createProductionSigner / SecretBackedSigner", () => {
  it("refuses to fabricate a production signer without a configured secret", () => {
    expect(() => createProductionSigner("liquidation")).toThrow(/no secret configured/);
  });

  it("imports a real key, signs, and derives the expected public key for the Pyth keeper role", async () => {
    const { seed, publicKey } = await realKeypair();
    const secret: ProductionSignerSecret = {
      role: "pyth",
      privateKeyMaterial: bytesToBase64(seed),
      expectedPublicKey: bytesToHex(publicKey),
    };
    const signer = createProductionSigner("pyth", secret);
    expect(await signer.publicKey()).toEqual(publicKey);
    const message = new TextEncoder().encode("pyth keeper transaction");
    const signature = await signer.sign(message);
    expect(signature.length).toBe(64);
    const verifyKey = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", verifyKey, signature, message)).toBe(true);
    expect(await signer.health()).toEqual({ ok: true });
  });

  it("works identically for the MagicBlock commit keeper role", async () => {
    const { seed, publicKey } = await realKeypair();
    const secret: ProductionSignerSecret = {
      role: "magicblock-commit",
      privateKeyMaterial: bytesToBase64(seed),
      expectedPublicKey: bytesToHex(publicKey),
    };
    const signer = createProductionSigner("magicblock-commit", secret);
    expect(await signer.publicKey()).toEqual(publicKey);
  });

  it("works identically for the funding keeper role, and accepts a JWK-JSON private key", async () => {
    const { seed, publicKey } = await realKeypair();
    const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    pkcs8.set(PKCS8_ED25519_PREFIX, 0);
    pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8.buffer, { name: "Ed25519" }, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
    const secret: ProductionSignerSecret = {
      role: "funding",
      privateKeyMaterial: JSON.stringify(jwk),
      expectedPublicKey: bytesToHex(publicKey),
    };
    const signer = createProductionSigner("funding", secret);
    expect(await signer.publicKey()).toEqual(publicKey);
  });

  it("rejects a role mismatch between the requested role and the secret's own role", async () => {
    const { seed, publicKey } = await realKeypair();
    const secret: ProductionSignerSecret = {
      role: "funding",
      privateKeyMaterial: bytesToBase64(seed),
      expectedPublicKey: bytesToHex(publicKey),
    };
    expect(() => new SecretBackedSigner(secret, "liquidation")).toThrow(/role mismatch/);
  });

  it("rejects a key whose derived public key does not match the configured expected key", async () => {
    const { seed } = await realKeypair();
    const { publicKey: wrongPublicKey } = await realKeypair();
    const secret: ProductionSignerSecret = {
      role: "pyth",
      privateKeyMaterial: bytesToBase64(seed),
      expectedPublicKey: bytesToHex(wrongPublicKey),
    };
    const signer = createProductionSigner("pyth", secret);
    await expect(signer.publicKey()).rejects.toThrow(/public key mismatch/);
    const health = await signer.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/public key mismatch/);
  });

  it("rejects malformed private key material without ever including it in the error", async () => {
    const { publicKey } = await realKeypair();
    const secret: ProductionSignerSecret = {
      role: "pyth",
      privateKeyMaterial: "not-a-valid-key-at-all!!!",
      expectedPublicKey: bytesToHex(publicKey),
    };
    let caught: unknown;
    try {
      createProductionSigner("pyth", secret);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/malformed private key material/);
    expect(message).not.toContain("not-a-valid-key-at-all");
  });

  it("uses a non-extractable CryptoKey for the actual signing operation", async () => {
    const { seed, publicKey } = await realKeypair();
    const secret: ProductionSignerSecret = {
      role: "pyth",
      privateKeyMaterial: bytesToBase64(seed),
      expectedPublicKey: bytesToHex(publicKey),
    };
    const signer = new SecretBackedSigner(secret, "pyth");
    await signer.sign(new Uint8Array([1, 2, 3]));
    const signingKey = (signer as unknown as { statePromise: Promise<{ signingKey: CryptoKey }> }).statePromise;
    const { signingKey: key } = await signingKey;
    expect(key.extractable).toBe(false);
  });
});

describe("RemoteSigner", () => {
  it("delegates every operation to its transport and holds no key material itself", async () => {
    const publicKey = new Uint8Array(32).fill(3);
    const signature = new Uint8Array(64).fill(9);
    const transport: RemoteSignerTransport = {
      publicKey: async () => publicKey,
      sign: async () => signature,
      health: async () => ({ ok: true }),
    };
    const signer = new RemoteSigner("kms-role", transport);
    expect(await signer.publicKey()).toBe(publicKey);
    expect(await signer.sign(new Uint8Array([1]))).toBe(signature);
    expect(await signer.health()).toEqual({ ok: true });
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
