/**
 * One market-maker tick, run by the MarketMaker Durable Object (placed in
 * Southeast Asia, next to the MagicBlock devnet-as validator).
 *
 * Each tick requotes Binance-style: it reads its own resting orders from the
 * rollup book and only replaces the rungs that drifted (atomic ReplaceOrder,
 * so a level is never empty), re-sizes a couple of settled rungs so the book
 * breathes like one with many participants, and a taker seat crosses the
 * touch with small IOC orders so real fills print. Every transaction's time is
 * measured from send to the rollup's "processed" websocket push.
 */
import { getBase58Decoder, type Instruction } from "@solana/kit";
import deployment from "../../config/stockstream-deployment.json";
import { cancelOrderIx, ladder, placeOrderIx, planQuotes, replaceOrderIx, type Bundle, type QuoteAction, type RestingOrder } from "./mm-encoding";
import { MagicBlockErTransport } from "./chain-transports";
import { LocalKeypairSigner, type Signer } from "./signer";
import { signAndSerializeTransaction } from "./transactions";
import { deriveBookPageV3, deriveEventShardV3, deriveSeatShardV3, V3_BOOK_PAGES_PER_SIDE } from "./v3-pdas";
import { decodeV3BookPage, decodeV3SeatShard } from "./v3-market-state";

const TAKE_EVERY_MS = [700, 2_200] as const;
const QUOTE_TTL_S = 60;
export const MAX_SNAPSHOT_AGE_S = 6;
const MAX_ACTIONS_PER_TICK = 12;
const JITTER_RUNGS_PER_TICK = 2;

export interface MakerEnv { MAGICBLOCK_RPC_URL?: string; MM_MAKER_KEYPAIR_JSON?: string; MM_TAKER_KEYPAIR_JSON?: string }
/** `ms`: send → rollup "processed" push (one network round trip + execution); `netMs`: plain network ping at the time. */
export interface ErTx { kind: string; ms: number | null; netMs: number | null; ok: boolean; at: number; signature: string; side?: "bid" | "ask"; price?: number; quantity?: number }
export interface TickMemo { clientId: string; nextTake: number }
export interface TickResult {
  stale: boolean; lastPrice: number | null; resting: number; maker: string; taker: string;
  quotes: number; replaced: number; cancelled: number; takes: number;
  recent: ErTx[]; pingMs: number; colo: string | null; memo: TickMemo; socketError: string | null;
}
interface Bot { signer: Signer; address: string; seat: number }

const decode64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const base58 = getBase58Decoder();
/** A serialized one-signer transaction's signature (bytes 1..65 after the compact count). */
const signatureOf = (transactionBase64: string) => base58.decode(decode64(transactionBase64).subarray(1, 65));

/** `signatureSubscribe` before a send; the "processed" push stops the clock. */
class SignatureSocket {
  private nextId = 1;
  private acks = new Map<number, (subscription: number) => void>();
  private waiters = new Map<number, (result: { at: number; ok: boolean }) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      const message = JSON.parse(text) as { id?: number; result?: number; method?: string; params?: { subscription: number; result: { value: { err: unknown } } } };
      if (message.id !== undefined && typeof message.result === "number") this.acks.get(message.id)?.(message.result);
      else if (message.method === "signatureNotification" && message.params) {
        this.waiters.get(message.params.subscription)?.({ at: Date.now(), ok: !message.params.result.value.err });
        this.waiters.delete(message.params.subscription);
      }
    });
  }
  static async open(rpcUrl: string) {
    const response = await fetch(rpcUrl, { headers: { Upgrade: "websocket" } });
    const ws = response.webSocket;
    if (!ws) throw new Error(`rollup websocket unavailable (HTTP ${response.status})`);
    ws.accept();
    return new SignatureSocket(ws);
  }
  close() { try { this.ws.close(1000, "tick done"); } catch { /* already closed */ } }
  /** Resolves once subscribed; `done` then settles on the processed push (or null after 3 s).
   * Wrapped in an object: an async function returning a bare promise would wait for it. */
  async watch(signature: string): Promise<{ done: Promise<{ at: number; ok: boolean } | null> }> {
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = await new Promise<number>((resolve, reject) => {
      this.acks.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "signatureSubscribe", params: [signature, { commitment: "processed" }] }));
      timer = setTimeout(() => reject(new Error("signatureSubscribe was not acknowledged")), 2_000);
    }).finally(() => { clearTimeout(timer); this.acks.delete(id); });
    return {
      done: new Promise((resolve) => {
        this.waiters.set(subscription, resolve);
        setTimeout(() => { if (this.waiters.delete(subscription)) resolve(null); }, 3_000);
      }),
    };
  }
}

// Isolate-scoped: stable across ticks that land on the same isolate.
let bundleCache: Bundle | null = null;
let botsCache: { maker: Bot; taker: Bot } | null = null;
let coloCache: string | null = null;

async function setup(env: MakerEnv, er: MagicBlockErTransport) {
  const core = deployment.core!;
  if (!bundleCache) {
    const bookPages = await Promise.all(Array.from({ length: 2 * V3_BOOK_PAGES_PER_SIDE }, (_, flat) => deriveBookPageV3(core, Math.floor(flat / V3_BOOK_PAGES_PER_SIDE), flat % V3_BOOK_PAGES_PER_SIDE)));
    const seatShards = await Promise.all(Array.from({ length: 4 }, (_, shard) => deriveSeatShardV3(core, shard)));
    const eventShards = await Promise.all(Array.from({ length: 4 }, (_, shard) => deriveEventShardV3(core, shard)));
    bundleCache = { core, bookPages, seatShards, eventShards, oracleSnapshot: deployment.oracleSnapshot! };
  }
  if (!botsCache) {
    if (!env.MM_MAKER_KEYPAIR_JSON || !env.MM_TAKER_KEYPAIR_JSON) throw new Error("MM_MAKER_KEYPAIR_JSON / MM_TAKER_KEYPAIR_JSON are not configured");
    const makerSigner = new LocalKeypairSigner("mm-maker", env.MM_MAKER_KEYPAIR_JSON);
    const takerSigner = new LocalKeypairSigner("mm-taker", env.MM_TAKER_KEYPAIR_JSON);
    const makerAddress = base58.decode(await makerSigner.publicKey());
    const takerAddress = base58.decode(await takerSigner.publicKey());
    const shards = await er.multipleAccounts(bundleCache.seatShards.map(String), "confirmed");
    const positions = shards.value.flatMap((account) => (account?.data ? decodeV3SeatShard(decode64(account.data[0]))?.positions ?? [] : []));
    const seatOf = (trader: string) => {
      const seat = positions.find((p) => p.trader === trader);
      if (!seat) throw new Error(`bot ${trader} has no seat in this market`);
      return seat.shard * 32 + seat.slot;
    };
    botsCache = {
      maker: { signer: makerSigner, address: makerAddress, seat: seatOf(makerAddress) },
      taker: { signer: takerSigner, address: takerAddress, seat: seatOf(takerAddress) },
    };
  }
  return { bundle: bundleCache, bots: botsCache };
}

export async function runMakerTick(env: MakerEnv, memo: TickMemo): Promise<TickResult> {
  const rpcUrl = env.MAGICBLOCK_RPC_URL ?? deployment.magicBlock.rpc;
  const er = new MagicBlockErTransport(rpcUrl);
  const [{ bundle, bots }, colo] = await Promise.all([
    setup(env, er),
    coloCache ? Promise.resolve(coloCache) : fetch("https://cloudflare.com/cdn-cgi/trace").then((r) => r.text()).then((t) => (coloCache = /colo=(\w+)/.exec(t)?.[1] ?? null)).catch(() => null),
  ]);
  const pingStart = Date.now();
  await er.call("getHealth", []).catch(() => undefined);
  const pingMs = Date.now() - pingStart;
  let clientId = BigInt(memo.clientId);
  let nextTake = memo.nextTake;
  const result: TickResult = {
    stale: false, lastPrice: null, resting: 0, maker: bots.maker.address, taker: bots.taker.address,
    quotes: 0, replaced: 0, cancelled: 0, takes: 0, recent: [], pingMs, colo, memo, socketError: null,
  };

  // Price the rollup will check the orders against.
  const snapshot = (await er.account(deployment.oracleSnapshot!)).value?.data?.[0];
  if (!snapshot) throw new Error("rollup has no oracle snapshot");
  const view = new DataView(decode64(snapshot).buffer);
  const index = view.getBigInt64(53, true);
  if (Math.floor(Date.now() / 1000) - Number(view.getBigUint64(69, true)) > MAX_SNAPSHOT_AGE_S) return { ...result, stale: true };
  result.lastPrice = Number(index) / 1e5;
  const now = Date.now();
  const nowS = BigInt(Math.floor(now / 1000));
  const [{ value }, accounts, sockets] = await Promise.all([
    er.latestBlockhash("confirmed"),
    er.multipleAccounts([...bundle.bookPages, ...bundle.seatShards], "confirmed"),
    SignatureSocket.open(rpcUrl).catch((error: unknown) => { result.socketError = String(error); return null; }),
  ]);
  const bytes = accounts.value.map((account) => (account?.data ? decode64(account.data[0]) : null));
  const resting: RestingOrder[] = bytes.slice(0, bundle.bookPages.length).flatMap((page) => (page ? decodeV3BookPage(page)?.nodes ?? [] : []))
    .filter((node) => node.tag === 2 && node.owner === bots.maker.seat)
    .map((node) => ({ key: node.key, side: node.side === 0 ? "bid" : "ask", price: node.priceOrOffset!, quantity: node.quantity!, expiresAt: node.expiresAt! }));
  const positions = bytes.slice(bundle.bookPages.length).flatMap((shard) => (shard ? decodeV3SeatShard(shard)?.positions ?? [] : []));
  const inventory = positions.find((p) => p.shard * 32 + p.slot === bots.maker.seat)?.basePosition ?? 0n;
  result.resting = resting.filter((order) => order.expiresAt > nowS).length;

  const submit = async (kind: string, bot: Bot, ix: Instruction, detail: Partial<ErTx> = {}) => {
    // Signed and subscribed before the clock starts: the time is network + rollup, nothing else.
    const transaction = await signAndSerializeTransaction({ instructions: [ix], signer: bot.signer, recentBlockhash: value.blockhash, computeUnitLimit: 600_000 });
    const signature = signatureOf(transaction);
    const processed = sockets ? await sockets.watch(signature).catch((error: unknown) => { result.socketError ??= String(error); return null; }) : null;
    const startedAt = Date.now();
    try {
      await er.sendTransaction(transaction, { skipPreflight: true });
    } catch { return; /* a rejected quote is re-planned next tick */ }
    const outcome = processed ? await processed.done : null;
    result.recent.push({ kind, at: startedAt, signature, netMs: pingMs, ms: outcome ? outcome.at - startedAt : null, ok: outcome?.ok ?? false, ...detail });
  };

  const targets = ladder(index, inventory);
  const actions: QuoteAction[] = planQuotes(resting, targets, index, nowS).slice(0, MAX_ACTIONS_PER_TICK);
  // Like other traders joining and leaving: re-size a couple of settled rungs each tick.
  const touched = new Set(actions.flatMap((action) => (action.kind === "cancel" ? [] : [`${action.quote.side}${action.quote.rung}`])));
  for (let n = 0; n < JITTER_RUNGS_PER_TICK && actions.length < MAX_ACTIONS_PER_TICK; n += 1) {
    const side = Math.random() < 0.5 ? "bid" : "ask";
    const live = resting.filter((order) => order.side === side && order.expiresAt > nowS).sort((x, y) => (side === "bid" ? Number(y.price - x.price) : Number(x.price - y.price)));
    const rung = Math.floor(Math.random() * Math.min(live.length, targets.length / 2));
    const quote = targets.find((target) => target.side === side && target.rung === rung);
    if (!live[rung] || !quote || touched.has(`${side}${rung}`)) continue;
    touched.add(`${side}${rung}`);
    actions.push({ kind: "replace", key: live[rung].key, quote: { ...quote, price: live[rung].price, quantity: quote.quantity + BigInt(Math.floor(Math.random() * 6)) } });
  }
  const expiresAt = nowS + BigInt(QUOTE_TTL_S);
  await Promise.all(actions.map((action) => {
    if (action.kind === "cancel") {
      result.cancelled += 1;
      return submit("cancel", bots.maker, cancelOrderIx(bundle, bots.maker.address, bots.maker.seat, action.key));
    }
    const order = { seatIndex: bots.maker.seat, side: action.quote.side, quantity: action.quote.quantity, price: action.quote.price, expiresAt, clientOrderId: (clientId += 1n), postOnly: true };
    const detail = { side: action.quote.side, price: Number(action.quote.price) / 1e5, quantity: Number(action.quote.quantity) };
    if (action.kind === "replace") {
      result.replaced += 1;
      return submit("replace", bots.maker, replaceOrderIx(bundle, bots.maker.address, action.key, order), detail);
    }
    result.quotes += 1;
    return submit("quote", bots.maker, placeOrderIx(bundle, bots.maker.address, order), detail);
  }));

  if (now >= nextTake) {
    const position = positions.find((p) => p.shard * 32 + p.slot === bots.taker.seat)?.basePosition ?? 0n;
    const side = position > 30n ? "ask" : position < -30n ? "bid" : Math.random() < 0.5 ? "bid" : "ask";
    const through = (index * 10n) / 10_000n;
    const quantity = BigInt(1 + Math.floor(Math.random() * 2));
    const price = side === "bid" ? index + through : index - through;
    await submit("take", bots.taker, placeOrderIx(bundle, bots.taker.address, {
      seatIndex: bots.taker.seat, side, quantity, price,
      expiresAt: nowS + 60n, clientOrderId: (clientId += 1n), immediateOrCancel: true,
    }), { side, price: Number(price) / 1e5, quantity: Number(quantity) });
    result.takes += 1;
    nextTake = now + TAKE_EVERY_MS[0] + Math.random() * (TAKE_EVERY_MS[1] - TAKE_EVERY_MS[0]);
  }
  sockets?.close();
  result.recent.sort((x, y) => y.at - x.at);
  result.memo = { clientId: String(clientId), nextTake };
  return result;
}
