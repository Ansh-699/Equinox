import { describe, expect, it, vi } from "vitest";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
} from "@solana/kit";
import { DeterministicTestSigner } from "./signer";
import { SolanaL1Transport } from "./chain-transports";
import { cancelOrderInstruction, depositCollateralInstruction, meta, placeOrderInstruction } from "./transactions";
import { coSignSessionTransaction, relaySessionTransaction, validateSessionTransaction } from "./session-relayer";

const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MARKET = "SysvarRent111111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";

/** Simulates the browser: builds a transaction with the relayer as fee
 * payer, the session key as an instruction signer, and signs only with the
 * session key -- exactly the partially-signed artifact the relayer receives. */
async function browserBuiltTransaction(feePayerAddress: string, sessionSigner: DeterministicTestSigner, instructionFactory: (sessionAddress: string) => ReturnType<typeof placeOrderInstruction>) {
  const sessionAddress = getBase58Decoder().decode(await sessionSigner.publicKey());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayerAddress), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 2n ** 64n - 1n }, m),
    (m) => appendTransactionMessageInstructions([instructionFactory(sessionAddress)], m),
  );
  const compiled = compileTransaction(message);
  const sessionSignatureBytes = await sessionSigner.sign(Uint8Array.from(compiled.messageBytes));
  const signed = { ...compiled, signatures: { ...compiled.signatures, [sessionAddress]: sessionSignatureBytes as SignatureBytes } };
  return { base64: getBase64EncodedWireTransaction(signed), sessionAddress };
}

describe("validateSessionTransaction", () => {
  it("accepts a well-formed session-signed PlaceOrder with the fee-payer slot empty", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const sessionSigner = new DeterministicTestSigner("session-key");
    const { base64, sessionAddress } = await browserBuiltTransaction(relayerAddress, sessionSigner, (s) =>
      placeOrderInstruction(PROGRAM, [meta(MARKET), meta(s, 3 as never)], { side: "bid", seatIndex: 0, quantity: 1n, priceOrOffset: 1n, clientOrderId: 1n }),
    );
    const result = validateSessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: sessionAddress }, relayerAddress);
    expect(result.ok).toBe(true);
  });

  it("rejects a disallowed opcode (DepositCollateral is never session-signable)", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const sessionSigner = new DeterministicTestSigner("session-key");
    const { base64, sessionAddress } = await browserBuiltTransaction(relayerAddress, sessionSigner, (s) =>
      depositCollateralInstruction(PROGRAM, [meta(MARKET), meta(s, 3 as never)], 0, 100n),
    );
    const result = validateSessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: sessionAddress }, relayerAddress);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/opcode/);
  });

  it("rejects an instruction targeting a program other than StockStream", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const sessionSigner = new DeterministicTestSigner("session-key");
    const { base64, sessionAddress } = await browserBuiltTransaction(relayerAddress, sessionSigner, (s) =>
      // Same PlaceOrder opcode, but addressed to a different program entirely.
      placeOrderInstruction("SysvarC1ock11111111111111111111111111111111", [meta(MARKET), meta(s, 3 as never)], { side: "bid", seatIndex: 0, quantity: 1n, priceOrOffset: 1n, clientOrderId: 1n }),
    );
    const result = validateSessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: sessionAddress }, relayerAddress);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unexpected program/);
  });

  it("rejects a transaction whose session signer never actually signed", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const sessionAddress = getBase58Decoder().decode(await new DeterministicTestSigner("session-key").publicKey());
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(relayerAddress), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 2n ** 64n - 1n }, m),
      (m) => appendTransactionMessageInstructions([placeOrderInstruction(PROGRAM, [meta(MARKET), meta(sessionAddress, 3 as never)], { side: "bid", seatIndex: 0, quantity: 1n, priceOrOffset: 1n, clientOrderId: 1n })], m),
    );
    const compiled = compileTransaction(message); // no signatures at all
    const base64 = getBase64EncodedWireTransaction(compiled);
    const result = validateSessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: sessionAddress }, relayerAddress);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/session signer/);
  });

  it("rejects a fee payer that isn't the relayer's own address", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const someoneElse = getBase58Decoder().decode(await new DeterministicTestSigner("someone-else").publicKey());
    const sessionSigner = new DeterministicTestSigner("session-key");
    const { base64, sessionAddress } = await browserBuiltTransaction(someoneElse, sessionSigner, (s) =>
      placeOrderInstruction(PROGRAM, [meta(MARKET), meta(s, 3 as never)], { side: "bid", seatIndex: 0, quantity: 1n, priceOrOffset: 1n, clientOrderId: 1n }),
    );
    const result = validateSessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: sessionAddress }, relayerAddress);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fee payer/);
  });
});

describe("coSignSessionTransaction / relaySessionTransaction", () => {
  it("adds a real, verifiable fee-payer signature over the exact same message the session key signed", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const sessionSigner = new DeterministicTestSigner("session-key");
    const { base64, sessionAddress } = await browserBuiltTransaction(relayerAddress, sessionSigner, (s) =>
      cancelOrderInstruction(PROGRAM, [meta(MARKET), meta(s, 3 as never)], 0, 1n),
    );

    const result = await coSignSessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: sessionAddress }, relayer);
    expect("base64" in result).toBe(true);
    if (!("base64" in result)) return;

    const decoded = getTransactionDecoder().decode(Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0)));
    const relayerSig = (decoded.signatures as Record<string, unknown>)[relayerAddress] as Uint8Array;
    const sessionSig = (decoded.signatures as Record<string, unknown>)[sessionAddress] as Uint8Array;
    expect(relayerSig).toBeTruthy();
    expect(sessionSig).toBeTruthy();

    const relayerKey = await crypto.subtle.importKey("raw", await relayer.publicKey(), { name: "Ed25519" }, false, ["verify"]);
    const sessionKey = await crypto.subtle.importKey("raw", await sessionSigner.publicKey(), { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", relayerKey, relayerSig, decoded.messageBytes)).toBe(true);
    expect(await crypto.subtle.verify("Ed25519", sessionKey, sessionSig, decoded.messageBytes)).toBe(true);
  });

  it("refuses to co-sign an invalid request and never touches the transport", async () => {
    const relayer = new DeterministicTestSigner("relayer");
    const relayerAddress = getBase58Decoder().decode(await relayer.publicKey());
    const sessionSigner = new DeterministicTestSigner("session-key");
    const { base64 } = await browserBuiltTransaction(relayerAddress, sessionSigner, (s) => depositCollateralInstruction(PROGRAM, [meta(MARKET), meta(s, 3 as never)], 0, 1n));

    const sendTransaction = vi.fn();
    const transport = { sendTransaction } as unknown as SolanaL1Transport;
    const result = await relaySessionTransaction({ transactionBase64: base64, expectedProgramAddress: PROGRAM, sessionSignerAddress: "irrelevant" }, relayer, transport);
    expect("error" in result).toBe(true);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
