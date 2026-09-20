import { describe, expect, it } from "vitest";
import { AccountRole, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction, getTransactionDecoder, type Transaction } from "@solana/kit";
import { DeterministicTestSigner } from "./signer";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  OPCODE,
  authorizeTradingSessionInstruction,
  base64ToBytes,
  cancelAllInstruction,
  cancelAllV3Instruction,
  cancelOrderV3Instruction,
  cleanupKeeperBuilder,
  commitMarketInstruction,
  consumeOracleUpdateInstruction,
  delegateMarketInstruction,
  depositCollateralInstruction,
  depositCollateralV3Instruction,
  fundingKeeperBuilder,
  initializeVaultInstruction,
  liquidationKeeperBuilder,
  meta,
  placeOrderInstruction,
  placeOrderV3Instruction,
  reconcileVaultInstruction,
  recordBadDebtInstruction,
  replaceOrderInstruction,
  replaceOrderV3Instruction,
  sessionKeeperBuilder,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  signAndSerializeTransaction,
  transitionMarketInstruction,
  updateFundingInstruction,
  withdrawCollateralInstruction,
  withdrawCollateralV3Instruction,
  withdrawProtocolFeesInstruction,
  type KeeperTransactionContext,
  type V3ExecutionAccountMetas,
} from "./transactions";

// Valid 32-byte base58 addresses (the program id is irrelevant to encoding).
const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MARKET = "SysvarRent111111111111111111111111111111111";
const OTHER = "SysvarC1ock11111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";

const base58 = getBase58Decoder();

function signerAccounts(address: string): { writable: ReturnType<typeof meta>; signer: ReturnType<typeof meta> } {
  return { writable: meta(address, AccountRole.WRITABLE), signer: meta(address, AccountRole.READONLY_SIGNER) };
}

async function importEd25519PublicKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
}

/** Raw 64-byte signature as stored in the decoded transaction (bytes or base58). */
function signatureBytesOf(decoded: Transaction, address: string): Uint8Array {
  const value = (decoded.signatures as Record<string, unknown>)[address];
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Uint8Array.from(getBase58Encoder().encode(value));
  throw new Error(`no signature for ${address}`);
}

describe("StockStream transaction construction (@solana/kit)", () => {
  it("diagnostic round-trip", async () => {
    const signer = new DeterministicTestSigner("diag");
    const addr = base58.decode(await signer.publicKey());
    const acc = meta(addr, AccountRole.READONLY_SIGNER);
    const base64 = await signAndSerializeTransaction({
      instructions: [reconcileVaultInstruction(PROGRAM, [meta(MARKET, AccountRole.WRITABLE), acc])],
      signer,
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 1000n,
    });
    const decoded = getTransactionDecoder().decode(base64ToBytes(base64));
    const key = await importEd25519PublicKey(await signer.publicKey());
    const ok = await crypto.subtle.verify("Ed25519", key, signatureBytesOf(decoded, addr), decoded.messageBytes);
    const bytes = base64ToBytes(base64);
    const rawSig = bytes.slice(1, 65);
    const rawMsg = bytes.slice(65);
    const rawOk = await crypto.subtle.verify("Ed25519", key, rawSig, rawMsg);
    const msgEqual = rawMsg.length === decoded.messageBytes.length && rawMsg.every((b, i) => b === decoded.messageBytes[i]);
    const directSig = await signer.sign(rawMsg);
    const directOk = await crypto.subtle.verify("Ed25519", key, directSig, rawMsg);
    const asString = getBase58Decoder().decode(directSig);
    const back = getBase58Encoder().encode(asString);
    const backOk = await crypto.subtle.verify("Ed25519", key, back, rawMsg);
    const manualB64 = getBase64EncodedWireTransaction({ messageBytes: rawMsg, signatures: { [addr]: asString } } as never);
    const manualBytes = base64ToBytes(manualB64);
    const manualOk = await crypto.subtle.verify("Ed25519", key, manualBytes.slice(1, 65), manualBytes.slice(65));
    console.log("DIAG", JSON.stringify({ rawOk, msgEqual, directOk, backOk, manualSig0: Array.from(manualBytes.slice(1, 5)), manualOk, sameAsBuilt: manualB64 === base64 }));
  });

  it("assembles, signs, and deserializes a real v0 transaction with a verifiable signature", async () => {
    const signer = new DeterministicTestSigner("unit-keeper");
    const signerAddress = base58.decode(await signer.publicKey());
    const accounts = signerAccounts(signerAddress);

    const base64 = await signAndSerializeTransaction({
      instructions: [depositCollateralInstruction(PROGRAM, [meta(MARKET, AccountRole.WRITABLE), accounts.signer, accounts.writable, accounts.writable], 0, 400n)],
      signer,
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 1000n,
    });

    const decoded = getTransactionDecoder().decode(base64ToBytes(base64));
    const signature = (decoded.signatures as Record<string, unknown>)[signerAddress];
    expect(signature).toBeTruthy();

    const signatureBytes = signatureBytesOf(decoded, signerAddress);
    expect(signatureBytes.length).toBe(64);

    const key = await importEd25519PublicKey(await signer.publicKey());
    const verified = await crypto.subtle.verify("Ed25519", key, signatureBytes, decoded.messageBytes);
    expect(verified).toBe(true);
  });

  it("encodes each instruction family to the exact wire layout and signs it", async () => {
    const signer = new DeterministicTestSigner("encoder-keeper");
    const signerAddress = base58.decode(await signer.publicKey());
    const accounts = signerAccounts(signerAddress).signer;
    const pairs = [meta(MARKET), meta(OTHER)];

    const families: { name: string; instruction: ReturnType<typeof placeOrderInstruction>; discriminator: number }[] = [
      { name: "initializeVault", instruction: initializeVaultInstruction(PROGRAM, pairs), discriminator: OPCODE.initializeVault },
      { name: "depositCollateral", instruction: depositCollateralInstruction(PROGRAM, pairs, 1, 1_000n), discriminator: OPCODE.depositCollateral },
      { name: "withdrawCollateral", instruction: withdrawCollateralInstruction(PROGRAM, pairs, 1, 1_000n), discriminator: OPCODE.withdrawCollateral },
      { name: "updateFunding", instruction: updateFundingInstruction(PROGRAM, [accounts, accounts], -5n, 42n), discriminator: OPCODE.updateFunding },
      { name: "transitionMarket", instruction: transitionMarketInstruction(PROGRAM, [accounts, accounts], "close-only"), discriminator: OPCODE.setCloseOnly },
      { name: "cancelAll", instruction: cancelAllInstruction(PROGRAM, [accounts, accounts], 2, 8, 3n), discriminator: OPCODE.cancelAll },
      { name: "placeOrder", instruction: placeOrderInstruction(PROGRAM, [accounts, accounts, accounts], { side: "ask", reduceOnly: true, seatIndex: 2, quantity: 5n, priceOrOffset: 100n, clientOrderId: 9n }), discriminator: OPCODE.placeOrder },
      { name: "replaceOrder", instruction: replaceOrderInstruction(PROGRAM, [accounts, accounts, accounts], 7n, { side: "bid", seatIndex: 2, quantity: 5n, priceOrOffset: 100n, clientOrderId: 9n }), discriminator: OPCODE.replaceOrder },
      { name: "authorizeSession", instruction: authorizeTradingSessionInstruction(PROGRAM, [accounts, accounts], { seatIndex: 2, expiresAt: 100n, actions: 0xff, maxOrderNotional: 10n, maxCumulativeNotional: 20n, maximumExposure: -1n, maximumOpenOrders: 4 }), discriminator: OPCODE.authorizeTradingSession },
      { name: "delegateMarket", instruction: delegateMarketInstruction(PROGRAM, [accounts, accounts], new Uint8Array(32).fill(1)), discriminator: OPCODE.delegateMarket },
      { name: "commitMarket", instruction: commitMarketInstruction(PROGRAM, [accounts, accounts], 5n, false), discriminator: OPCODE.commitMarket },
      { name: "commitAndUndelegate", instruction: commitMarketInstruction(PROGRAM, [accounts, accounts], 5n, true), discriminator: OPCODE.commitAndUndelegate },
      { name: "transferToInsuranceFund", instruction: withAmount(OPCODE.transferToInsuranceFund, accounts, 5n), discriminator: OPCODE.transferToInsuranceFund },
      { name: "withdrawProtocolFees", instruction: withdrawProtocolFeesInstruction(PROGRAM, [accounts, accounts], 5n), discriminator: OPCODE.withdrawProtocolFees },
      { name: "recordBadDebt", instruction: recordBadDebtInstruction(PROGRAM, [accounts, accounts], 3, 5n), discriminator: OPCODE.recordBadDebt },
      { name: "reconcileVault", instruction: reconcileVaultInstruction(PROGRAM, [accounts, accounts]), discriminator: OPCODE.reconcileVault },
      { name: "consumeOracleUpdate", instruction: consumeOracleUpdateInstruction(PROGRAM, [accounts, accounts], 0, 0, new Uint8Array(120).fill(0xaa)), discriminator: OPCODE.consumeOracleUpdate },
    ];

    for (const family of families) {
      expect(family.instruction.data![0], `${family.name} discriminator`).toBe(family.discriminator);
      const base64 = await signAndSerializeTransaction({
        instructions: [family.instruction],
        signer,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: 1000n,
      });
      const decoded = getTransactionDecoder().decode(base64ToBytes(base64));
      const signature = (decoded.signatures as Record<string, unknown>)[signerAddress];
      expect(signature, `${family.name} signature`).toBeTruthy();
      const key = await importEd25519PublicKey(await signer.publicKey());
      expect(await crypto.subtle.verify("Ed25519", key, signatureBytesOf(decoded, signerAddress), decoded.messageBytes), `${family.name} verifies`).toBe(true);
    }
  });

  it("pins the multi-byte instruction layouts", () => {
    const deposit = depositCollateralInstruction(PROGRAM, [meta(MARKET)], 0x0102, 0x0102030405060708n);
    expect(Array.from(deposit.data!.slice(0, 11))).toEqual([10, 0x02, 0x01, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);

    const funding = updateFundingInstruction(PROGRAM, [meta(MARKET)], -1n, 2n);
    expect(funding.data!.length).toBe(25);
    expect(funding.data![0]).toBe(6);
    expect(Array.from(funding.data!.slice(1, 17))).toEqual(Array(16).fill(0xff)); // -1 as i128

    const place = placeOrderInstruction(PROGRAM, [meta(MARKET)], { side: "ask", reduceOnly: true, seatIndex: 1, quantity: 2n, priceOrOffset: 3n, clientOrderId: 4n });
    expect(place.data!.length).toBe(54);
    expect(place.data![1]).toBe(1); // ask
    expect(place.data![3]).toBe(4); // reduce-only flag bit
  });

  it("requires the canonical V3 bundle and emits V3 custody opcodes", () => {
    const writable = meta(MARKET, AccountRole.WRITABLE);
    const readonly = meta(OTHER);
    const v3: V3ExecutionAccountMetas = {
      core: writable,
      bookPages: Array.from({ length: 18 }, () => writable),
      seatShards: Array.from({ length: 4 }, () => writable),
      eventShards: Array.from({ length: 4 }, () => writable),
      authority: meta(OTHER, AccountRole.READONLY_SIGNER),
    };
    expect(placeOrderV3Instruction(PROGRAM, v3, { side: "bid", seatIndex: 0, quantity: 1n, priceOrOffset: 10n, clientOrderId: 1n }).accounts).toHaveLength(28);
    expect(cancelOrderV3Instruction(PROGRAM, v3, 0, 1n).accounts).toHaveLength(28);
    expect(cancelAllV3Instruction(PROGRAM, v3, 0, 8).accounts).toHaveLength(28);
    expect(replaceOrderV3Instruction(PROGRAM, v3, 1n, { side: "bid", seatIndex: 0, quantity: 1n, priceOrOffset: 10n, clientOrderId: 2n }).accounts).toHaveLength(28);
    const deposit = depositCollateralV3Instruction(PROGRAM, {
      core: writable, seatShard: writable, eventShards: Array.from({ length: 4 }, () => writable),
      authority: meta(OTHER, AccountRole.READONLY_SIGNER), source: writable, vault: writable, mint: readonly, tokenProgram: readonly,
    }, 0, 1n);
    expect(deposit.data![0]).toBe(53);
    expect(deposit.accounts).toHaveLength(11);
    const withdraw = withdrawCollateralV3Instruction(PROGRAM, {
      ...v3, destination: writable, mint: readonly, vault: writable, vaultAuthority: readonly, tokenProgram: readonly,
    }, 0, 1n);
    expect(withdraw.data![0]).toBe(54);
    expect(withdraw.accounts).toHaveLength(33);
    expect(() => withdrawCollateralV3Instruction(PROGRAM, { ...v3, session: readonly, destination: writable, mint: readonly, vault: writable, vaultAuthority: readonly, tokenProgram: readonly }, 0, 1n)).toThrow("session PDA");
  });
});

function withAmount(discriminator: number, authority: ReturnType<typeof meta>, amount: bigint) {
  const data = new Uint8Array(9);
  data[0] = discriminator;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return { programAddress: PROGRAM, accounts: [meta(MARKET, AccountRole.WRITABLE), authority], data } as never as ReturnType<typeof replaceOrderInstruction>;
}

describe("keeper transaction builders", () => {
  it("build signed transactions for the funding, session, liquidation and cleanup keepers", async () => {
    const signer = new DeterministicTestSigner("keeper-builders");
    const signerAddress = base58.decode(await signer.publicKey());
    const context: KeeperTransactionContext & { seatIndex: number } = {
      programAddress: PROGRAM,
      market: MARKET,
      authority: signerAddress,
      seatIndex: 4,
    };
    expect(context.authority).toBe(signerAddress);

    const funding = await fundingKeeperBuilder(context).build({ accumulator: 12n, timestamp: 34 }, signer, BLOCKHASH);
    const session = await sessionKeeperBuilder(context).build({ targetMode: "paused" }, signer, BLOCKHASH);
    const liquidation = await liquidationKeeperBuilder(context).build({ seatIndex: 4, maxQuantity: 9n }, signer, BLOCKHASH);
    const cleanup = await cleanupKeeperBuilder(context).build({ maxRemovals: 8 }, signer, BLOCKHASH);

    for (const [name, base64] of Object.entries({ funding, session, liquidation, cleanup })) {
      const decoded = getTransactionDecoder().decode(base64ToBytes(base64));
      const signature = (decoded.signatures as Record<string, unknown>)[signerAddress];
      expect(signature, `${name} builder signed`).toBeTruthy();
      const key = await importEd25519PublicKey(await signer.publicKey());
      expect(await crypto.subtle.verify("Ed25519", key, signatureBytesOf(decoded, signerAddress), decoded.messageBytes), `${name} verifies`).toBe(true);
    }
  });
});

describe("compute budget", () => {
  it("encodes SetComputeUnitLimit and SetComputeUnitPrice against the ComputeBudget native program with the exact discriminant + LE layout", () => {
    const limit = setComputeUnitLimitInstruction(60_000);
    expect(limit.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(limit.accounts).toEqual([]);
    expect(Array.from(limit.data!)).toEqual([2, 0x60, 0xea, 0x00, 0x00]); // 60_000 = 0x0000ea60, LE

    const price = setComputeUnitPriceInstruction(1_000n);
    expect(price.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(Array.from(price.data!.slice(0, 1))).toEqual([3]);
    expect(Array.from(price.data!.slice(1))).toEqual([0xe8, 0x03, 0, 0, 0, 0, 0, 0]); // 1000 = 0x3e8, LE u64
  });

  it("every signed transaction includes a compute-budget instruction by default, addressed to the ComputeBudget program", async () => {
    const signer = new DeterministicTestSigner("compute-budget-default");
    const base64 = await signAndSerializeTransaction({
      instructions: [reconcileVaultInstruction(PROGRAM, [meta(MARKET, AccountRole.WRITABLE)])],
      signer,
      recentBlockhash: BLOCKHASH,
    });
    const messageBytes = base64ToBytes(base64).slice(65); // skip the 1-byte shortvec count + 64-byte signature
    const computeBudgetProgramBytes = Uint8Array.from(getBase58Encoder().encode(COMPUTE_BUDGET_PROGRAM_ID));
    expect(containsSubarray(messageBytes, computeBudgetProgramBytes)).toBe(true);
  });

  it("computeUnitLimit: null omits the compute-budget instruction entirely", async () => {
    const signer = new DeterministicTestSigner("compute-budget-omitted");
    const base64 = await signAndSerializeTransaction({
      instructions: [reconcileVaultInstruction(PROGRAM, [meta(MARKET, AccountRole.WRITABLE)])],
      signer,
      recentBlockhash: BLOCKHASH,
      computeUnitLimit: null,
    });
    const messageBytes = base64ToBytes(base64).slice(65);
    const computeBudgetProgramBytes = Uint8Array.from(getBase58Encoder().encode(COMPUTE_BUDGET_PROGRAM_ID));
    expect(containsSubarray(messageBytes, computeBudgetProgramBytes)).toBe(false);
  });
});

function containsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
