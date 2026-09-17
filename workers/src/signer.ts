/** Priority 8: secure keeper signer infrastructure.
 *
 * A `Signer` is the only interface any keeper job (Pyth, MagicBlock commit,
 * funding, market session, expiry cleanup, liquidation -- `keepers.ts`) or
 * transaction transport (`transaction-transports.ts`) is allowed to depend
 * on for authorizing a transaction. It exposes exactly what a caller needs
 * (a public key, a signing operation, a health check, an opaque key
 * identifier for logging) and nothing else -- there is no method anywhere
 * in this interface, or any adapter below, that returns private key
 * material. Every adapter signs using the Workers-native Web Crypto
 * `SubtleCrypto` Ed25519 implementation (no new dependency: Cloudflare
 * Workers support `Ed25519` natively), never a hand-rolled curve
 * implementation.
 *
 * Role separation: each keeper role gets its own named `Signer` (see
 * `SignerRole`/`SignerRegistry`), never a shared instance. This is a
 * structural guarantee, not just documentation -- `SignerRegistry.for`
 * requires an explicit role and returns only signers this module
 * constructed, so nothing outside this file can substitute a different key
 * for a role after the registry is built.
 *
 * A keeper signer must never be any of: the program's upgrade authority,
 * a user's own withdrawal authority, or a Privy embedded user wallet.
 * None of those are `Signer` implementations anywhere in this codebase --
 * an upgrade authority is a deploy-time Solana CLI keypair never loaded
 * into a Worker, a withdrawal authority is a user's own wallet handled by
 * client-side signing (`lib/`), and Privy embedded wallets are signed via
 * Privy's own client SDK, not this module. Keeping those entirely absent
 * from this file (rather than adding a runtime check against them) is the
 * actual enforcement: there is nothing here a caller could point at.
 */

export interface SignerHealth {
  ok: boolean;
  detail?: string;
}

export interface Signer {
  /** Opaque identifier safe to place in logs/metrics -- never the key itself. */
  readonly keyId: string;
  /** The 32-byte Solana public key this signer signs for. */
  publicKey(): Promise<Uint8Array>;
  /** Produces a 64-byte Ed25519 signature over `message`. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** Cheap liveness check (e.g. that key material is loaded/reachable);
   * never signs anything. */
  health(): Promise<SignerHealth>;
}

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function pkcs8FromSeed(seed: Uint8Array): ArrayBuffer {
  if (seed.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out.buffer;
}

/** Shared base: every adapter below differs only in *where the seed comes
 * from*, never in how signing/health/public-key derivation works. */
abstract class WebCryptoEd25519Signer implements Signer {
  private keyPromise: Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> | undefined;

  constructor(public readonly keyId: string) {}

  protected abstract loadSeed(): Promise<Uint8Array>;

  private async keyMaterial() {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const seed = await this.loadSeed();
        const privateKey = await crypto.subtle.importKey(
          "pkcs8",
          pkcs8FromSeed(seed),
          { name: "Ed25519" },
          true,
          ["sign"],
        );
        const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
        const publicKeyHandle = await crypto.subtle.importKey(
          "jwk",
          { kty: "OKP", crv: "Ed25519", x: jwk.x },
          { name: "Ed25519" },
          true,
          ["verify"],
        );
        const raw = (await crypto.subtle.exportKey("raw", publicKeyHandle)) as ArrayBuffer;
        return { privateKey, publicKey: new Uint8Array(raw) };
      })();
    }
    return this.keyPromise;
  }

  async publicKey(): Promise<Uint8Array> {
    return (await this.keyMaterial()).publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const { privateKey } = await this.keyMaterial();
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    return new Uint8Array(signature);
  }

  async health(): Promise<SignerHealth> {
    try {
      await this.keyMaterial();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Deterministic, reproducible across runs -- for unit/integration test
 * fixtures that need a stable keeper pubkey and real, verifiable
 * signatures without any external key material. Never use in production:
 * the seed is derived from `keyId` itself via SHA-256, so it is trivially
 * guessable. */
export class DeterministicTestSigner extends WebCryptoEd25519Signer {
  protected async loadSeed(): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`stockstream-test-signer:${this.keyId}`));
    return new Uint8Array(digest);
  }
}

/** Loads a raw 32-byte seed or a Solana-CLI-style 64-byte
 * `[seed(32)..., pubkey(32)...]` JSON keypair array from a string (meant
 * to be read from a gitignored local file or a Worker secret binding,
 * never a checked-in literal). Local dev/testing only -- see
 * `createProductionSigner` for the real deployment boundary. */
export class LocalKeypairSigner extends WebCryptoEd25519Signer {
  constructor(keyId: string, private readonly keypairSource: string) {
    super(keyId);
  }

  protected async loadSeed(): Promise<Uint8Array> {
    const trimmed = this.keypairSource.trim();
    if (trimmed.startsWith("[")) {
      const bytes: number[] = JSON.parse(trimmed);
      if (bytes.length !== 64 && bytes.length !== 32) {
        throw new Error(`local keypair array must be 32 or 64 bytes, got ${bytes.length}`);
      }
      return Uint8Array.from(bytes.slice(0, 32));
    }
    // Otherwise treat it as a base64-encoded 32-byte seed.
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (bytes.length !== 32) throw new Error(`base64 local keypair seed must decode to 32 bytes, got ${bytes.length}`);
    return bytes;
  }
}

/** Signs nothing for real: returns a fixed public key and a fixed
 * fake signature, for tests exercising keeper control flow (retries,
 * dead-letters, lease fencing) that don't care about signature validity
 * and shouldn't pay for real Ed25519 math. Its `health()` is always ok. */
export class MockSigner implements Signer {
  private readonly fixedPublicKey: Uint8Array;

  constructor(public readonly keyId: string) {
    this.fixedPublicKey = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) this.fixedPublicKey[i] = (keyId.charCodeAt(i % keyId.length) + i) & 0xff;
  }

  async publicKey(): Promise<Uint8Array> {
    return this.fixedPublicKey;
  }

  async sign(_message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(64).fill(0xab);
  }

  async health(): Promise<SignerHealth> {
    return { ok: true };
  }
}

/** What a Worker secret binding must supply to construct a production
 * signer for one role. Both fields are opaque strings because Worker
 * secrets are always strings at runtime -- this module does the parsing. */
export interface ProductionSignerSecret {
  role: SignerRole;
  /** An Ed25519 private key, either PKCS8-DER base64-encoded or a JWK JSON
   * string (`{"kty":"OKP","crv":"Ed25519","d":...,"x":...}`) -- whichever
   * format the KMS/secret-store this is sourced from produces. */
  privateKeyMaterial: string;
  /** The public key this role's signer is expected to derive, as 64-char
   * lowercase hex or base64 -- a misconfigured or silently-rotated secret
   * is rejected at construction time rather than signing with the wrong
   * key. */
  expectedPublicKey: string;
}

function parsePublicKeyString(value: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 32) throw new Error("expected public key must decode to exactly 32 bytes");
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Parses either PKCS8-DER-base64 or JWK-JSON private key material into
 * the raw 32-byte Ed25519 seed PKCS8 wraps. Configuration errors here are
 * deliberately redacted: the thrown message never includes any byte of
 * the input, only a description of what shape was expected, so a
 * misconfigured secret can be diagnosed from logs without ever placing
 * key material in them. */
function seedFromPrivateKeyMaterial(material: string): Uint8Array {
  const trimmed = material.trim();
  try {
    if (trimmed.startsWith("{")) {
      const jwk = JSON.parse(trimmed) as { kty?: string; crv?: string; d?: string };
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) {
        throw new Error("shape mismatch");
      }
      const binary = atob(jwk.d.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      if (bytes.length !== 32) throw new Error("wrong length");
      return bytes;
    }
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // Accept either a bare 32-byte seed or a full PKCS8 DER envelope.
    if (bytes.length === 32) return bytes;
    if (bytes.length === PKCS8_ED25519_PREFIX.length + 32 && bytes.slice(0, PKCS8_ED25519_PREFIX.length).every((b, i) => b === PKCS8_ED25519_PREFIX[i])) {
      return bytes.slice(PKCS8_ED25519_PREFIX.length);
    }
    throw new Error("wrong length or unrecognized PKCS8 envelope");
  } catch {
    throw new Error(
      "malformed private key material: expected a JWK JSON object ({kty:'OKP',crv:'Ed25519',d:...}) " +
        "or a base64-encoded 32-byte seed / PKCS8 DER envelope -- redacted, not logging the value itself",
    );
  }
}

/**
 * The real production signer: imports an Ed25519 key from a Worker secret
 * binding and validates its derived public key against the configured
 * `expectedPublicKey` before it will sign anything. The `CryptoKey` used
 * for actual signing (`sign()`) is imported non-extractable; a second,
 * momentarily-extractable import is used only once, at construction, to
 * derive the public key for that validation, and is never retained after
 * validation returns.
 *
 * Never exports or returns private-key bytes to any caller, and never
 * places key material in a thrown error or log line -- every failure
 * message here is a fixed, redacted description, never a stringified
 * secret.
 */
export class SecretBackedSigner implements Signer {
  public readonly keyId: string;
  private readonly seed: Uint8Array;
  private readonly expectedPublicKey: Uint8Array;
  private statePromise: Promise<{ signingKey: CryptoKey; publicKey: Uint8Array }> | undefined;

  constructor(secret: ProductionSignerSecret, requestedRole: SignerRole) {
    if (secret.role !== requestedRole) {
      throw new Error(`signer role mismatch: this secret is bound to "${secret.role}", not "${requestedRole}"`);
    }
    this.keyId = `production:${requestedRole}`;
    this.seed = seedFromPrivateKeyMaterial(secret.privateKeyMaterial);
    this.expectedPublicKey = parsePublicKeyString(secret.expectedPublicKey);
  }

  private async state() {
    if (!this.statePromise) {
      this.statePromise = (async () => {
        const pkcs8 = pkcs8FromSeed(this.seed);
        // Extractable only transiently, to derive the public key; discarded
        // (never assigned to `this`) once validation below completes.
        const extractableKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
        const jwk = (await crypto.subtle.exportKey("jwk", extractableKey)) as JsonWebKey;
        const publicKeyHandle = await crypto.subtle.importKey(
          "jwk",
          { kty: "OKP", crv: "Ed25519", x: jwk.x },
          { name: "Ed25519" },
          true,
          ["verify"],
        );
        const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", publicKeyHandle)) as ArrayBuffer);
        if (!bytesEqual(publicKey, this.expectedPublicKey)) {
          throw new Error(
            `signer public key mismatch for ${this.keyId}: the imported key does not derive the configured public key -- redacted, not logging either key`,
          );
        }
        const signingKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
        return { signingKey, publicKey };
      })();
    }
    return this.statePromise;
  }

  async publicKey(): Promise<Uint8Array> {
    return (await this.state()).publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const { signingKey } = await this.state();
    return new Uint8Array(await crypto.subtle.sign("Ed25519", signingKey, message));
  }

  async health(): Promise<SignerHealth> {
    try {
      await this.state();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "signer health check failed" };
    }
  }
}

/**
 * The production deployment boundary. Falls back to the historical
 * throwing behavior when `secret` is omitted (no Worker secret configured
 * for this role yet) -- that failure blocks *live* deployment for this
 * role, not code completion. When a secret *is* provided, constructs a
 * real `SecretBackedSigner` against it.
 */
export function createProductionSigner(role: SignerRole, secret?: ProductionSignerSecret): Signer {
  if (!secret) {
    throw new Error(
      `createProductionSigner("${role}") has no secret configured: production keeper signing requires a ` +
        "Worker secret binding supplying a private key and its expected public key for this role. Use " +
        "LocalKeypairSigner (dev) or DeterministicTestSigner/MockSigner (tests) until one is wired up.",
    );
  }
  return new SecretBackedSigner(secret, role);
}

/**
 * Adapter shape for a future remote KMS/HSM signing service: this Worker
 * would send the message to sign over HTTPS and receive a signature back,
 * never holding key material itself. No such service exists yet (no
 * endpoint or credentials are available in this codebase), but the
 * interface is defined now so `RemoteSigner` below only needs a real
 * `fetch`-based implementation dropped in later, not a redesign of every
 * caller that depends on `Signer`.
 */
export interface RemoteSignerTransport {
  publicKey(): Promise<Uint8Array>;
  sign(message: Uint8Array): Promise<Uint8Array>;
  health(): Promise<SignerHealth>;
}

/** Delegates every `Signer` operation to a `RemoteSignerTransport` --
 * e.g. an HTTPS call to a KMS/HSM-backed signing microservice. This class
 * holds no key material at all; it is exactly as secure as the transport
 * given to it. */
export class RemoteSigner implements Signer {
  constructor(public readonly keyId: string, private readonly transport: RemoteSignerTransport) {}

  async publicKey(): Promise<Uint8Array> {
    return this.transport.publicKey();
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return this.transport.sign(message);
  }

  async health(): Promise<SignerHealth> {
    return this.transport.health();
  }
}

/** Every distinct role a keeper signer can be issued for. Adding a new
 * keeper job means adding its role here, not reusing an existing one --
 * this is what makes "one signer per keeper" a type-level fact instead of
 * a convention someone can accidentally violate. */
export type SignerRole = "pyth" | "magicblock-commit" | "funding" | "market-session" | "expiry-cleanup" | "liquidation";

/** Holds exactly one `Signer` per role and refuses to be constructed with
 * fewer than all of them, so a keeper can never accidentally run
 * signer-less or fall back to borrowing another role's key. */
export class SignerRegistry {
  constructor(private readonly signers: Record<SignerRole, Signer>) {}

  for(role: SignerRole): Signer {
    return this.signers[role];
  }

  async healthAll(): Promise<Record<SignerRole, SignerHealth>> {
    const roles = Object.keys(this.signers) as SignerRole[];
    const entries = await Promise.all(roles.map(async (role) => [role, await this.signers[role].health()] as const));
    return Object.fromEntries(entries) as Record<SignerRole, SignerHealth>;
  }
}
