import { Connection, PublicKey } from "@solana/web3.js";
import { TOTAL_SUPPLY } from "./dbc-launch";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SUPPLY_UNITS = TOTAL_SUPPLY * 1e6;

/** What Pulse shows per launch beyond the curve itself, all read from the chain. */
export interface LaunchStats {
  /** Wallets holding the token (program vaults excluded). */
  holders: number;
  /** Share of total supply held by the ten largest wallets, and by the creator. */
  top10Pct: number;
  devPct: number;
  /** Transactions on the curve (and the DAMM v2 pool once graduated); `txnsCapped` at 1,000 each. */
  txns: number;
  txnsCapped: boolean;
  lastTradeAt: number | null;
  image: string | null;
}

/** Holder figures from one scan of the mint's token accounts: owner and amount
 * only. Accounts owned by a PDA (the curve's and the DAMM pool's vaults) are not holders. */
export function holderStats(accounts: readonly { owner: PublicKey; amount: bigint }[], creator: string) {
  const wallets = new Map<string, bigint>();
  for (const { owner, amount } of accounts) {
    if (amount <= 0n || !PublicKey.isOnCurve(owner.toBytes())) continue;
    wallets.set(owner.toBase58(), (wallets.get(owner.toBase58()) ?? 0n) + amount);
  }
  const sorted = [...wallets.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const pct = (units: bigint) => (Number(units) / SUPPLY_UNITS) * 100;
  return { holders: wallets.size, top10Pct: pct(sorted.slice(0, 10).reduce((sum, v) => sum + v, 0n)), devPct: pct(wallets.get(creator) ?? 0n) };
}

/** Metaplex metadata: key · update authority · mint · name · symbol · uri (u32-length strings). */
function metadataUri(data: Uint8Array): string | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 65;
  for (let field = 0; field < 3; field += 1) {
    if (offset + 4 > data.length) return null;
    const length = view.getUint32(offset, true);
    const text = new TextDecoder().decode(data.subarray(offset + 4, offset + 4 + length)).replace(/\0+$/, "").trim();
    if (field === 2) return text || null;
    offset += 4 + length;
  }
  return null;
}

const images = new Map<string, Promise<string | null>>();
/** A token's image: its metadata URI is either the image itself or JSON with `image`. */
function tokenImage(connection: Connection, mint: string): Promise<string | null> {
  const cached = images.get(mint);
  if (cached) return cached;
  const load = (async () => {
    const [pda] = PublicKey.findProgramAddressSync([new TextEncoder().encode("metadata"), METADATA_PROGRAM.toBytes(), new PublicKey(mint).toBytes()], METADATA_PROGRAM);
    const account = await connection.getAccountInfo(pda);
    const uri = account ? metadataUri(account.data) : null;
    if (!uri || !/^https:\/\//.test(uri)) return null;
    if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(uri)) return uri;
    const response = await fetch(uri, { signal: AbortSignal.timeout(6_000) });
    if ((response.headers.get("content-type") ?? "").startsWith("image/")) return uri;
    const json = await response.json() as { image?: unknown };
    return typeof json.image === "string" && /^https:\/\//.test(json.image) ? json.image : null;
  })().catch(() => null);
  images.set(mint, load);
  return load;
}

export async function readLaunchStats(connection: Connection, launch: { pool: string; baseMint: string; creator: string; dammPool: string | null }): Promise<LaunchStats> {
  const [accounts, curveTxs, poolTxs, image] = await Promise.all([
    connection.getProgramAccounts(TOKEN_PROGRAM, {
      dataSlice: { offset: 32, length: 40 },
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: launch.baseMint } }],
    }),
    connection.getSignaturesForAddress(new PublicKey(launch.pool), { limit: 1_000 }),
    launch.dammPool ? connection.getSignaturesForAddress(new PublicKey(launch.dammPool), { limit: 1_000 }) : Promise.resolve([]),
    tokenImage(connection, launch.baseMint),
  ]);
  const holders = holderStats(accounts.map(({ account }) => {
    const bytes = Uint8Array.from(account.data);
    return { owner: new PublicKey(bytes.subarray(0, 32)), amount: new DataView(bytes.buffer).getBigUint64(32, true) };
  }), launch.creator);
  const times = [...curveTxs, ...poolTxs].map((tx) => tx.blockTime ?? 0).filter(Boolean);
  return {
    ...holders,
    txns: curveTxs.length + poolTxs.length,
    txnsCapped: curveTxs.length === 1_000 || poolTxs.length === 1_000,
    lastTradeAt: times.length ? Math.max(...times) * 1_000 : null,
    image,
  };
}
