/**
 * Worker-native V3 PDA derivation. The browser/client ABI currently exposes
 * web3.js PublicKey helpers, but Workers must not inherit that Node-oriented
 * dependency graph just to derive read-only shard addresses.
 */
import { address, getBase58Encoder, getProgramDerivedAddress } from "@solana/kit";
import { STOCKSTREAM_PROGRAM_ID } from "../../clients/stockstream/src/constants";

export const V3_BOOK_PAGES_PER_SIDE = 9;

const programAddress = address(STOCKSTREAM_PROGRAM_ID);
const utf8 = new TextEncoder();
const base58 = getBase58Encoder();

function coreSeed(core: string) {
  // PDA seeds use the 32 public-key bytes, not the base58 text. `address()`
  // validates the user input before the codec produces those exact bytes.
  return base58.encode(address(core));
}

async function derive(seed: string, core: string, suffix: readonly number[]): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [utf8.encode(seed), coreSeed(core), Uint8Array.from(suffix)],
  });
  return pda;
}

export async function deriveBookPageV3(core: string, side: number, page: number): Promise<string> {
  if (!Number.isInteger(side) || side < 0 || side > 1 || !Number.isInteger(page) || page < 0 || page >= V3_BOOK_PAGES_PER_SIDE)
    throw new RangeError("invalid V3 book page");
  return derive("book-page-v3", core, [side, page]);
}

export async function deriveSeatShardV3(core: string, shard: number): Promise<string> {
  if (!Number.isInteger(shard) || shard < 0 || shard >= 4) throw new RangeError("invalid V3 seat shard");
  return derive("seat-shard-v3", core, [shard]);
}

export async function deriveEventShardV3(core: string, shard: number): Promise<string> {
  if (!Number.isInteger(shard) || shard < 0 || shard >= 4) throw new RangeError("invalid V3 event shard");
  return derive("event-shard-v3", core, [shard]);
}
