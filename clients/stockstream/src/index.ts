import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { STOCKSTREAM_ACCOUNT_SIZE, STOCKSTREAM_INSTRUCTION, STOCKSTREAM_PROGRAM_ID, STOCKSTREAM_TRADING_SESSION_SIZE } from "./constants";

export const STOCKSTREAM_PROGRAM_KEY = new PublicKey(STOCKSTREAM_PROGRAM_ID);
export type AddressInput = PublicKey | string;
export type Side = "bid" | "ask";
export type OrderTree = "fixed" | "oracle-pegged";

export interface InstructionAccounts {
  market: AddressInput;
  authority: AddressInput;
}

export interface PlaceOrderParams extends InstructionAccounts {
  /** Per-market/per-seat PDA: ["settlement", market, seat_index_le]. */
  settlementScratch: AddressInput;
  seatIndex: number;
  side: Side;
  tree?: OrderTree;
  quantity: bigint | number;
  priceOrOffset: bigint | number;
  expiresAt?: bigint | number;
  pegLimit?: bigint | number;
  clientOrderId: bigint | number;
  /** Required for scoped-session actions. Main-wallet actions must use zero. */
  actionNonce?: bigint | number;
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  reduceOnly?: boolean;
  /** Program-owned TradingSession account when authority is a scoped signer. */
  session?: AddressInput;
}

export interface InstructionFixture {
  name: string;
  data: Uint8Array;
}
export interface SessionAuthorizedAccounts extends InstructionAccounts { session?: AddressInput; }

export interface VaultAccounts { market: AddressInput; authority: AddressInput; mint: AddressInput; tokenProgram: AddressInput; vault: AddressInput; vaultAuthority: AddressInput; }
export interface CustodyAccounts extends VaultAccounts { seat: AddressInput; seatIndex: number; sourceOrDestination: AddressInput; }
export interface DelegationAccounts { market: AddressInput; authority: AddressInput; instrument: AddressInput; payer: AddressInput; scratchAccounts?: AddressInput[]; }
export interface CommitAccounts { market: AddressInput; authority: AddressInput; payer: AddressInput; scratchAccounts?: AddressInput[]; }

/** MagicBlock Delegation Program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`. */
export const MAGICBLOCK_DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
/** MagicBlock Magic Program: `Magic11111111111111111111111111111111111111`. */
export const MAGICBLOCK_MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
/** MagicBlock Magic Context account: `MagicContext1111111111111111111111111111111`. */
export const MAGICBLOCK_MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export interface RegistryAccounts { exchange: AddressInput; authority: AddressInput; }
export interface InstrumentAccounts { exchange: AddressInput; instrument: AddressInput; authority: AddressInput; }
export interface PerpMarketAccounts { instrument: AddressInput; market: AddressInput; authority: AddressInput; }

function publicKey(value: AddressInput): PublicKey {
  if (value instanceof PublicKey) return value;
  try { return new PublicKey(value); } catch { throw new RangeError("Invalid Solana public key"); }
}

function checkedUnsigned(value: bigint | number, bits: number, name: string): bigint {
  const result = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : -1n;
  if (result < 0n || result >= 1n << BigInt(bits)) throw new RangeError(`${name} is outside u${bits}`);
  return result;
}

function checkedSigned(value: bigint | number, bits: number, name: string): bigint {
  const result = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n;
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (result < min || result > max) throw new RangeError(`${name} is outside i${bits}`);
  return result;
}

function writeUnsigned(data: Uint8Array, offset: number, value: bigint, bytes: number) {
  let current = value;
  for (let i = 0; i < bytes; i += 1) { data[offset + i] = Number(current & 0xffn); current >>= 8n; }
}

function writeSigned(data: Uint8Array, offset: number, value: bigint, bytes: number) {
  writeUnsigned(data, offset, value < 0n ? (1n << BigInt(bytes * 8)) + value : value, bytes);
}

function accountMeta(address: AddressInput, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey: publicKey(address), isSigner, isWritable };
}

function instruction(data: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: STOCKSTREAM_PROGRAM_KEY, keys: accounts, data: Buffer.from(data) });
}

export function initializeMarket(accounts: InstructionAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeMarket), [
    accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false),
  ]);
}

export function createTraderSeat(accounts: InstructionAccounts, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.createTraderSeat; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function initializeSettlementScratch(accounts: InstructionAccounts & { settlementScratch: AddressInput }, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.initializeSettlementScratch; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.settlementScratch, false, true)]);
}

export function closeTraderSeat(accounts: InstructionAccounts, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.closeTraderSeat; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function placeOrder(params: PlaceOrderParams): TransactionInstruction {
  const data = new Uint8Array(54);
  data[0] = STOCKSTREAM_INSTRUCTION.placeOrder;
  data[1] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[2] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[3] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0);
  if (data[1] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 4, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 6, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, 14, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, 22, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, 30, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, 38, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  writeUnsigned(data, 46, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const accounts = [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)];
  if (params.session) accounts.push(accountMeta(params.session, false, true));
  return instruction(data, accounts);
}

/**
 * Atomically cancels `oldOrderKey` and places a new order in its place. The
 * new order always receives a fresh sequence number, so a replacement
 * always loses book time priority. If the new order fails validation
 * (margin, session notional, ...), the whole instruction reverts, leaving
 * the original order, its reserve, and the session's nonce/notional
 * untouched -- see `handlers::replace_order` in the Rust program.
 */
export function replaceOrder(params: PlaceOrderParams & { oldOrderKey: bigint }): TransactionInstruction {
  const data = new Uint8Array(70);
  data[0] = STOCKSTREAM_INSTRUCTION.replaceOrder;
  writeUnsigned(data, 1, checkedUnsigned(params.oldOrderKey, 128, "oldOrderKey"), 16);
  data[17] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[18] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[19] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0);
  if (data[17] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 20, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 22, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, 30, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, 38, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, 46, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, 54, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  writeUnsigned(data, 62, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const accounts = [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)];
  if (params.session) accounts.push(accountMeta(params.session, false, true));
  return instruction(data, accounts);
}

export function cancelOrder(accounts: SessionAuthorizedAccounts, seatIndex: number, orderKey: bigint, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(27); data[0] = STOCKSTREAM_INSTRUCTION.cancelOrder; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(orderKey, 128, "orderKey"), 16); writeUnsigned(data, 19, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const metas = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]; if (accounts.session) metas.push(accountMeta(accounts.session, false, true)); return instruction(data, metas);
}

export function cancelAll(accounts: SessionAuthorizedAccounts, seatIndex: number, maxCancellations: number, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(12); data[0] = STOCKSTREAM_INSTRUCTION.cancelAll; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); data[3] = Number(checkedUnsigned(maxCancellations, 8, "maxCancellations")); writeUnsigned(data, 4, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const metas = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]; if (accounts.session) metas.push(accountMeta(accounts.session, false, true)); return instruction(data, metas);
}

export function updateFunding(accounts: InstructionAccounts, accumulator: bigint, timestamp: bigint | number): TransactionInstruction {
  const data = new Uint8Array(25); data[0] = STOCKSTREAM_INSTRUCTION.updateFunding; writeSigned(data, 1, checkedSigned(accumulator, 128, "accumulator"), 16); writeUnsigned(data, 17, checkedUnsigned(timestamp, 64, "timestamp"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function liquidate(accounts: InstructionAccounts, seatIndex: number, maxQuantity: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = STOCKSTREAM_INSTRUCTION.liquidate; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(maxQuantity, 64, "maxQuantity"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function initializeVault(accounts: VaultAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeVault), [
    accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.mint, false, false),
    accountMeta(accounts.tokenProgram, false, false), accountMeta(accounts.vault, false, true), accountMeta(accounts.vaultAuthority, false, false),
  ]);
}

function amountInstruction(discriminator: number, accounts: CustodyAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(accounts.seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.seat, false, true), accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.vault, false, true), accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false)]);
}
export function depositCollateral(accounts: CustodyAccounts, amount: bigint | number) { return amountInstruction(STOCKSTREAM_INSTRUCTION.depositCollateral, accounts, amount); }
export function withdrawCollateral(accounts: CustodyAccounts, amount: bigint | number) {
  const result = amountInstruction(STOCKSTREAM_INSTRUCTION.withdrawCollateral, accounts, amount);
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from('vault-authority'), new PublicKey(accounts.market).toBuffer()], new PublicKey(STOCKSTREAM_PROGRAM_ID))[0];
  result.keys = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.mint, false, false),
    accountMeta(accounts.vault, false, true), accountMeta(vaultAuthority, false, false), accountMeta(accounts.tokenProgram, false, false)];
  return result;
}

export function consumeOracleUpdate(accounts: { market: AddressInput; payer: AddressInput; pythProgram: AddressInput; storage: AddressInput; treasury: AddressInput; systemProgram: AddressInput; instructionsSysvar: AddressInput }, message: Uint8Array): TransactionInstruction {
  if (message.length < 103 || message.length > 512) throw new RangeError('Invalid signed Pyth message length');
  const data = new Uint8Array(1 + message.length); data[0] = STOCKSTREAM_INSTRUCTION.consumeOracleUpdate; data.set(message, 1);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.payer, true, true),
    accountMeta(accounts.pythProgram, false, false), accountMeta(accounts.storage, false, false),
    accountMeta(accounts.treasury, false, true), accountMeta(accounts.systemProgram, false, false),
    accountMeta(accounts.instructionsSysvar, false, false)]);
}
/**
 * Real onchain MagicBlock `DelegateMarket`. Account order and the delegation
 * program/PDA derivations mirror `programs/stockstream/src/magicblock.rs`
 * exactly (which is itself verified against the delegation program's own
 * `magicblock-delegation-program-api` crate and source) -- this is not an
 * independent encoding, it must match the Rust side byte-for-byte.
 */
export function delegateMarket(accounts: DelegationAccounts, validator: AddressInput): TransactionInstruction {
  const market = publicKey(accounts.market);
  const validatorKey = publicKey(validator);
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), market.toBuffer()], STOCKSTREAM_PROGRAM_KEY);
  const [delegationRecord] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), market.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const [delegationMetadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), market.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const data = new Uint8Array(33); data[0] = STOCKSTREAM_INSTRUCTION.delegateMarket; data.set(validatorKey.toBytes(), 1);
  return instruction(data, [
    accountMeta(market, false, true),
    accountMeta(accounts.authority, true, false),
    accountMeta(accounts.instrument, false, false),
    accountMeta(accounts.payer, true, true),
    accountMeta(buffer, false, true),
    accountMeta(delegationRecord, false, true),
    accountMeta(delegationMetadata, false, true),
    accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false),
    accountMeta(SystemProgram.programId, false, false),
    accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false),
    ...(accounts.scratchAccounts ?? []).map((a) => accountMeta(a, false, true)),
  ]);
}
function commitInstruction(discriminator: number, accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, [
    accountMeta(accounts.market, false, true),
    accountMeta(accounts.authority, true, false),
    accountMeta(accounts.payer, true, true),
    accountMeta(MAGICBLOCK_MAGIC_CONTEXT_ID, false, true),
    accountMeta(MAGICBLOCK_MAGIC_PROGRAM_ID, false, false),
    ...(accounts.scratchAccounts ?? []).map((a) => accountMeta(a, false, true)),
  ]);
}
export function commitMarket(accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction { return commitInstruction(STOCKSTREAM_INSTRUCTION.commitMarket, accounts, sequence); }
export function commitAndUndelegate(accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction { return commitInstruction(STOCKSTREAM_INSTRUCTION.commitAndUndelegate, accounts, sequence); }
// There is no client-side `undelegationCallback` builder: the delegation
// program itself invokes StockStream via CPI using its own fixed
// `EXTERNAL_UNDELEGATE_DISCRIMINATOR` wire format
// (`[196, 28, 41, 206, 48, 37, 51, 167]`), never a transaction a client
// constructs. See `programs/stockstream/src/magicblock.rs::external_undelegate`.
/** Session action allowlist bits -- must match `session::SESSION_ACTION_*` exactly. */
export const SESSION_ACTION = {
  place: 1 << 0,
  cancel: 1 << 1,
  cancelAll: 1 << 2,
  replace: 1 << 3,
  /** Permits `PlaceOrder` only when the order carries the reduce-only flag. */
  reduceOnlyClose: 1 << 4,
} as const;

/**
 * Canonical `TradingSession` PDA: `["trading_session", owner, market,
 * seat_index_le, session_signer]`. Must match
 * `session::derive_trading_session` in the Rust program exactly.
 */
export function deriveTradingSession(owner: AddressInput, market: AddressInput, seatIndex: number, sessionSigner: AddressInput): PublicKey {
  const seatIndexBytes = new Uint8Array(2);
  new DataView(seatIndexBytes.buffer).setUint16(0, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("trading_session"), publicKey(owner).toBuffer(), publicKey(market).toBuffer(), Buffer.from(seatIndexBytes), publicKey(sessionSigner).toBuffer()],
    STOCKSTREAM_PROGRAM_KEY,
  )[0];
}

export interface TradingSessionAccounts extends InstructionAccounts { sessionSigner: AddressInput; payer: AddressInput; }
export interface SessionControlAccounts extends InstructionAccounts { session: AddressInput; sessionSigner: AddressInput; }
export interface TradingSessionPolicy { seatIndex: number; actions: number; maxOrderNotional: bigint | number; maxCumulativeNotional: bigint | number; maximumExposure: bigint | number; maximumOpenOrders: number; }

function sessionLimitsInstruction(discriminator: number, accounts: [AddressInput, boolean, boolean][], expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  if (!Number.isInteger(policy.seatIndex) || policy.seatIndex < 0 || policy.seatIndex > 0xffff || !Number.isInteger(policy.actions) || policy.actions <= 0 || policy.actions > 0xff || !Number.isInteger(policy.maximumOpenOrders) || policy.maximumOpenOrders <= 0 || policy.maximumOpenOrders > 0xffff) throw new RangeError("invalid trading session policy");
  const maxOrder = checkedUnsigned(policy.maxOrderNotional, 64, "maxOrderNotional");
  const maxCumulative = checkedUnsigned(policy.maxCumulativeNotional, 64, "maxCumulativeNotional");
  const maximumExposure = BigInt(policy.maximumExposure);
  if (maxOrder === 0n || maxCumulative < maxOrder || maximumExposure <= 0n || maximumExposure >= 2n ** 127n) throw new RangeError("invalid trading session limits");
  const data = new Uint8Array(46); const view = new DataView(data.buffer);
  data[0] = discriminator; view.setUint16(1, policy.seatIndex, true); writeUnsigned(data, 3, checkedUnsigned(expiresAt, 64, "expiresAt"), 8);
  data[11] = policy.actions; writeUnsigned(data, 12, maxOrder, 8); writeUnsigned(data, 20, maxCumulative, 8); writeSigned(data, 28, maximumExposure, 16); view.setUint16(44, policy.maximumOpenOrders, true);
  return instruction(data, accounts.map(([addr, isSigner, isWritable]) => accountMeta(addr, isSigner, isWritable)));
}

/**
 * Creates and initializes the canonical `TradingSession` PDA via a real
 * System Program CPI performed by the program itself (a PDA cannot sign a
 * top-level client transaction, so the client cannot pre-create this
 * account the way it could a keypair account). `next_expected_nonce`
 * always starts at `1`; there is no caller-supplied initial nonce.
 */
export function authorizeTradingSession(accounts: TradingSessionAccounts, expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  return sessionLimitsInstruction(
    STOCKSTREAM_INSTRUCTION.authorizeTradingSession,
    [
      [accounts.market, false, true],
      [accounts.payer, true, true],
      [deriveTradingSession(accounts.authority, accounts.market, policy.seatIndex, accounts.sessionSigner), false, true],
      [accounts.sessionSigner, false, false],
      [SystemProgram.programId, false, false],
    ],
    expiresAt,
    policy,
  );
}

/** Never callable by the session signer itself -- only the owner (`accounts.authority`) may tighten or loosen limits, and a revoked session cannot be updated back to life. */
export function updateTradingSessionLimits(accounts: SessionControlAccounts, expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  return sessionLimitsInstruction(
    STOCKSTREAM_INSTRUCTION.updateTradingSessionLimits,
    [
      [accounts.market, false, true],
      [accounts.authority, true, false],
      [accounts.session, false, true],
      [accounts.sessionSigner, false, false],
    ],
    expiresAt,
    policy,
  );
}

export function revokeTradingSession(accounts: SessionControlAccounts, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.revokeTradingSession; new DataView(data.buffer).setUint16(1, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.session, false, true), accountMeta(accounts.sessionSigner, false, false)]); }

/** Reclaims the session PDA's rent to the owner. Only callable once the session is revoked or expired. */
export function closeTradingSession(accounts: SessionControlAccounts, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.closeTradingSession; new DataView(data.buffer).setUint16(1, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, true), accountMeta(accounts.session, false, true), accountMeta(accounts.sessionSigner, false, false)]); }

function identifierInstruction(discriminator: number, identifier: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  if (identifier.length !== 32) throw new RangeError("identifier must be 32 bytes");
  const data = new Uint8Array(33); data[0] = discriminator; data.set(identifier, 1); return instruction(data, accounts);
}
export function initializeExchange(accounts: RegistryAccounts): TransactionInstruction { return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeExchange), [accountMeta(accounts.exchange, false, true), accountMeta(accounts.authority, true, false)]); }
export function registerStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.registerStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, true), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function createPerpMarket(accounts: PerpMarketAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.createPerpMarket, instrumentId, [accountMeta(accounts.instrument, false, false), accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function updateStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array, pythFeedId: number, oracleChannel: number, priceExponent: number): TransactionInstruction { if (!Number.isInteger(pythFeedId) || pythFeedId <= 0 || pythFeedId > 0xffff_ffff) throw new RangeError("pythFeedId must be a non-zero u32"); if (!Number.isInteger(oracleChannel) || oracleChannel < 1 || oracleChannel > 4) throw new RangeError("oracleChannel must be between 1 and 4"); const data = new Uint8Array(42); const view = new DataView(data.buffer); data[0] = STOCKSTREAM_INSTRUCTION.updateStockInstrument; data.set(instrumentId, 1); view.setUint32(33, pythFeedId, true); data[37] = oracleChannel; view.setInt32(38, priceExponent, true); return instruction(data, [accountMeta(accounts.exchange, false, false), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function suspendStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.suspendStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, false), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function updateMarketRisk(accounts: InstructionAccounts, initial: number, maintenance: number, leverage: number): TransactionInstruction { const data = new Uint8Array(9); data[0] = STOCKSTREAM_INSTRUCTION.updateMarketRisk; const view = new DataView(data.buffer); view.setUint16(1, initial, true); view.setUint16(3, maintenance, true); view.setUint32(5, leverage, true); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function transitionMarket(accounts: InstructionAccounts, mode: "pause" | "resume" | "close-only" | "corporate-action" | "resolve" | "close"): TransactionInstruction { const discriminator = { pause: STOCKSTREAM_INSTRUCTION.pauseMarket, resume: STOCKSTREAM_INSTRUCTION.resumeMarket, "close-only": STOCKSTREAM_INSTRUCTION.setCloseOnly, "corporate-action": STOCKSTREAM_INSTRUCTION.enterCorporateAction, resolve: STOCKSTREAM_INSTRUCTION.resolveCorporateAction, close: STOCKSTREAM_INSTRUCTION.closeMarket }[mode]; return instruction(Uint8Array.of(discriminator), [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }

export function decodeInstruction(data: Uint8Array): InstructionFixture {
  if (data.length === 0) throw new RangeError("Empty instruction");
  const names: Record<number, string> = { 0: "InitializeMarket", 1: "CreateTraderSeat", 2: "CloseTraderSeat", 3: "PlaceOrder", 4: "CancelOrder", 5: "CancelAll", 6: "UpdateFunding", 7: "Liquidate", 8: "InitializeSettlementScratch", 9: "InitializeVault", 10: "DepositCollateral", 11: "WithdrawCollateral", 12: "ConsumeOracleUpdate", 13: "DelegateMarket", 14: "CommitMarket", 15: "CommitAndUndelegate", 16: "UndelegationCallback", 17: "AuthorizeTradingSession", 18: "RevokeTradingSession", 19: "InitializeExchange", 20: "RegisterStockInstrument", 21: "CreatePerpMarket", 22: "UpdateStockInstrument", 23: "SuspendStockInstrument", 24: "UpdateMarketRisk", 25: "PauseMarket", 26: "ResumeMarket", 27: "SetCloseOnly", 28: "EnterCorporateAction", 29: "ResolveCorporateAction", 30: "CloseMarket", 31: "UpdateTradingSessionLimits", 32: "CloseTradingSession", 33: "ReplaceOrder" };
  const name = names[data[0]];
  if (!name) throw new RangeError("Unknown instruction");
  return { name, data: data.slice() };
}

export interface MarketStateView {
  discriminator: string;
  version: number;
  initialized: boolean;
  mode: number;
  marketAuthority: PublicKey;
  oracleValid: boolean;
  lastVerifiedOraclePrice: bigint;
  lastVerifiedOracleTimestamp: bigint;
  bidArenaOffset: number;
  askArenaOffset: number;
  traderSeatOffset: number;
  fillEventOffset: number;
}

export function decodeMarketState(data: Uint8Array): MarketStateView {
  if (data.byteLength !== STOCKSTREAM_ACCOUNT_SIZE) throw new RangeError("Invalid StockStream market account size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bytes = data.slice(0, 8); const discriminator = new TextDecoder().decode(bytes);
  if (discriminator !== "STKMRK01" || view.getUint16(8, true) !== 1) throw new RangeError("Invalid StockStream market header");
  if (view.getUint32(311, true) !== 512 || view.getUint32(315, true) !== 91152 ||
      view.getUint32(319, true) !== 181792 || view.getUint32(323, true) !== 214560)
    throw new RangeError('Invalid StockStream regions');
  return { discriminator, version: 1, initialized: view.getUint8(10) === 1, mode: view.getUint8(11), marketAuthority: new PublicKey(data.slice(12, 44)), oracleValid: view.getUint8(294) === 1, lastVerifiedOraclePrice: view.getBigInt64(295, true), lastVerifiedOracleTimestamp: view.getBigUint64(303, true), bidArenaOffset: view.getUint32(311, true), askArenaOffset: view.getUint32(315, true), traderSeatOffset: view.getUint32(319, true), fillEventOffset: view.getUint32(323, true) };
}

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

function readSignedLE(data: Uint8Array, offset: number, bytes: number): bigint {
  let value = 0n;
  for (let i = bytes - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]);
  const signBit = 1n << BigInt(bytes * 8 - 1);
  return value >= signBit ? value - (signBit << 1n) : value;
}

export interface TradingSessionView {
  discriminator: string;
  version: number;
  initialized: boolean;
  revoked: boolean;
  owner: PublicKey;
  sessionSigner: PublicKey;
  targetProgram: PublicKey;
  market: PublicKey;
  traderSeatIndex: number;
  createdAt: bigint;
  expiresAt: bigint;
  actions: number;
  maxOrderNotional: bigint;
  maxCumulativeNotional: bigint;
  consumedCumulativeNotional: bigint;
  maxExposure: bigint;
  maxOpenOrders: number;
  nextExpectedNonce: bigint;
  lastActionTimestamp: bigint;
  sessionGeneration: number;
}

/** Must match `session::TradingSession`'s packed byte layout exactly. */
export function decodeTradingSession(data: Uint8Array): TradingSessionView {
  if (data.byteLength !== STOCKSTREAM_TRADING_SESSION_SIZE) throw new RangeError("Invalid TradingSession account size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const discriminator = new TextDecoder().decode(data.slice(0, 8));
  if (discriminator !== "STKSES02" || view.getUint16(8, true) !== 1) throw new RangeError("Invalid TradingSession header");
  return {
    discriminator,
    version: view.getUint16(8, true),
    initialized: view.getUint8(10) === 1,
    revoked: view.getUint8(11) === 1,
    owner: new PublicKey(data.slice(12, 44)),
    sessionSigner: new PublicKey(data.slice(44, 76)),
    targetProgram: new PublicKey(data.slice(76, 108)),
    market: new PublicKey(data.slice(108, 140)),
    traderSeatIndex: view.getUint16(140, true),
    createdAt: view.getBigUint64(142, true),
    expiresAt: view.getBigUint64(150, true),
    actions: view.getUint8(158),
    maxOrderNotional: view.getBigUint64(159, true),
    maxCumulativeNotional: view.getBigUint64(167, true),
    consumedCumulativeNotional: view.getBigUint64(175, true),
    maxExposure: readSignedLE(data, 183, 16),
    maxOpenOrders: view.getUint16(199, true),
    nextExpectedNonce: view.getBigUint64(201, true),
    lastActionTimestamp: view.getBigUint64(209, true),
    sessionGeneration: view.getUint32(217, true),
  };
}

export function previewPlaceOrder(params: PlaceOrderParams) {
  const tx = placeOrder(params);
  return { programId: STOCKSTREAM_PROGRAM_ID, instruction: "PlaceOrder", accounts: tx.keys.map((account) => ({ address: account.pubkey.toBase58(), signer: account.isSigner, writable: account.isWritable })), signers: tx.keys.filter((account) => account.isSigner).map((account) => account.pubkey.toBase58()), side: params.side, quantity: String(params.quantity), limitPrice: String(params.priceOrOffset), estimatedInternalMargin: "Unavailable until verified oracle pricing" };
}

export { SystemProgram };
