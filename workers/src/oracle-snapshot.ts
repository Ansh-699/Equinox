/** Read-only decoder for the L1-owned OracleSnapshotV3 account. */
export const ORACLE_SNAPSHOT_SIZE = 128;
export interface OracleSnapshotView {
  core: Uint8Array; feedId: number; channel: number; exponent: number;
  price: bigint; confidence: bigint; publishTimestamp: bigint; sequence: bigint;
  session: number; tradingStatus: number; authenticated: boolean;
  revision: number;
}
export function decodeOracleSnapshot(bytes: Uint8Array): OracleSnapshotView {
  if (bytes.length !== ORACLE_SNAPSHOT_SIZE || new TextDecoder().decode(bytes.slice(0, 8)) !== "STKORS03" || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true) !== 3 || bytes[10] !== 1 || bytes[87] !== 1) throw new Error("Invalid OracleSnapshotV3");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { core: bytes.slice(12, 44), feedId: view.getUint32(44, true), channel: bytes[48], exponent: view.getInt32(49, true), price: view.getBigInt64(53, true), confidence: view.getBigUint64(61, true), publishTimestamp: view.getBigUint64(69, true), sequence: view.getBigUint64(77, true), session: bytes[85], tradingStatus: bytes[86], authenticated: true, revision: bytes[88] };
}

export interface SnapshotAccountReader {
  account(address: string, commitment?: 'confirmed' | 'finalized'): Promise<{ context: { slot: number }; value: { data: [string, string] } | null }>;
}

/** Read-only L1/ER account reader. It deliberately performs no transaction
 * construction or submission and rejects absent/non-base64 account data. */
export async function readOracleSnapshot(reader: SnapshotAccountReader, address: string, commitment: 'confirmed' | 'finalized' = 'finalized'): Promise<{ slot: number; snapshot: OracleSnapshotView } | null> {
  const result = await reader.account(address, commitment);
  const encoded = result.value?.data?.[0];
  if (!encoded) return null;
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { slot: result.context.slot, snapshot: decodeOracleSnapshot(bytes) };
}
