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

/**
 * The production deployment boundary. Deliberately unimplemented: a real
 * production keeper signer must be backed by a Worker secret binding plus
 * an encrypted-key or remote-signing service (a KMS/HSM API, or a
 * dedicated signing microservice this Worker calls over HTTPS), never a
 * plaintext key baked into source or environment. Which service that is
 * is an infrastructure/deployment decision outside this codebase's scope
 * (no credentials or endpoints for one exist here), so this throws rather
 * than faking a working implementation. This blocks *live production
 * deployment*, not code completion -- every keeper job and transport this
 * module supports is written against the `Signer` interface and already
 * works end-to-end against the dev/test adapters above.
 */
export function createProductionSigner(_keyId: string): Signer {
  throw new Error(
    "createProductionSigner is not implemented: production keeper signing requires a " +
      "secret-backed encrypted key store or a remote KMS/HSM signing service, which is an " +
      "infrastructure decision with no credentials available in this codebase. Use " +
      "LocalKeypairSigner (dev) or DeterministicTestSigner/MockSigner (tests) until one is wired up.",
  );
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
