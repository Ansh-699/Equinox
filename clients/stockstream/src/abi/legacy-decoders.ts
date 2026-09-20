export interface BookMetadata { version: number; fixedRoot: number; peggedRoot: number; fixedLeaves: number; peggedLeaves: number; bumpIndex: number; freeHead: number; freeLength: number; }
export function decodeBookMetadata(data: Uint8Array): BookMetadata {
  if (data.byteLength < 32) throw new RangeError("Invalid book region");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { version: view.getUint32(0, true), fixedRoot: view.getUint32(4, true), peggedRoot: view.getUint32(8, true), fixedLeaves: view.getUint32(12, true), peggedLeaves: view.getUint32(16, true), bumpIndex: view.getUint32(20, true), freeHead: view.getUint32(24, true), freeLength: view.getUint32(28, true) };
}
export interface FillEventView { sequence: bigint; maker: number; taker: number; price: bigint; quantity: bigint; }
export function decodeFillEvent(data: Uint8Array): FillEventView {
  if (data.byteLength !== 64) throw new RangeError("Invalid fill event size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { sequence: view.getBigUint64(0, true), maker: view.getUint32(8, true), taker: view.getUint32(12, true), price: view.getBigInt64(16, true), quantity: view.getBigUint64(24, true) };
}
