/** Shared test-only helper for building a real binary Equinox event log
 * line (`Program data: <base64>`), matching `programs/equinox/src/events.rs`
 * exactly. Used by every test that needs a realistic decoded event without
 * duplicating the byte-layout logic per test file. */

const EVENT_SIZE = 100;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function seatAmountPayload(seat: number, amount: number, balance: number): Uint8Array {
  const payload = new Uint8Array(48);
  const view = new DataView(payload.buffer);
  view.setUint16(0, seat, true);
  view.setBigUint64(2, BigInt(amount), true);
  view.setBigUint64(10, BigInt(balance), true);
  return payload;
}

/** Builds one `Program data: <base64>` log line: header (discriminator u16
 * LE, abi_version u8, reserved u8, sequence u64 LE, market[32], timestamp
 * u64 LE) + a 48-byte payload (defaults to all-zero, valid for any
 * discriminator whose payload fields aren't under test). `market` accepts a
 * 64-char hex string (as the rest of this codebase represents markets) for
 * convenience. */
export function eventLogLine(
  discriminator: number,
  sequence: number,
  marketHex: string,
  payload: Uint8Array = new Uint8Array(48),
  timestamp = 1_700_000_000,
): string {
  const bytes = new Uint8Array(EVENT_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, discriminator, true);
  view.setUint8(2, 1);
  view.setBigUint64(4, BigInt(sequence), true);
  for (let i = 0; i < 32; i += 1) bytes[12 + i] = parseInt(marketHex.slice(i * 2, i * 2 + 2), 16);
  view.setBigUint64(44, BigInt(timestamp), true);
  bytes.set(payload, 52);
  return `Program data: ${bytesToBase64(bytes)}`;
}
