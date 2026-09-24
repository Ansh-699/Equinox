/** Range checks and little-endian integer writers shared by instruction
 * builders. Keeping these primitives in the ABI layer prevents the public
 * facade from becoming a second wire-format authority. */
export function checkedUnsigned(value: bigint | number, bits: number, name: string): bigint {
  const result = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : -1n;
  if (result < 0n || result >= 1n << BigInt(bits)) throw new RangeError(`${name} is outside u${bits}`);
  return result;
}

export function checkedSigned(value: bigint | number, bits: number, name: string): bigint {
  const result = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n;
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (result < min || result > max) throw new RangeError(`${name} is outside i${bits}`);
  return result;
}

export function writeUnsigned(data: Uint8Array, offset: number, value: bigint, bytes: number): void {
  let current = value;
  for (let i = 0; i < bytes; i += 1) {
    data[offset + i] = Number(current & 0xffn);
    current >>= 8n;
  }
}

export function writeSigned(data: Uint8Array, offset: number, value: bigint, bytes: number): void {
  writeUnsigned(data, offset, value < 0n ? (1n << BigInt(bytes * 8)) + value : value, bytes);
}
