"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openWalletDrawer, TopBar } from "@/components/layout/top-bar";
import { ExecutionStatusBanner, ProtocolStatusStrip } from "@/components/layout/status-strip";
import { useAppAuth } from "@/components/app-providers";
import { isSessionUsable } from "@/lib/session-trading";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { cancelAllV3, cancelOrderV3, createTraderSeat, createV3TraderSeat, deriveV3ExecutionAccounts, initializeSettlementScratch, initializeVault, previewPlaceOrder } from "@/clients/equinox/src";
import { marketForSymbol } from "@/lib/markets";
import { useWithdraw, evaluateWithdrawGate } from "@/features/collateral/use-withdraw";
import { useDeposit } from "@/features/collateral/use-deposit";
import { resolveCustodyAccounts } from "@/features/collateral/custody-accounts";
import { useEquinoxProtocol } from "@/features/wallet/use-equinox-protocol";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useSessionOrder } from "@/features/sessions/use-session-order";
import { SessionPolicyPanel } from "@/features/sessions/session-policy-panel";
import type { SessionActionResult } from "@/lib/session-relay-status";
import type { OrderTree } from "@/clients/equinox/src";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useV3MarketState } from "@/features/magicblock/use-v3-market-state";
import { usePosition } from "@/features/positions/use-position";
import { useMarketClock } from "@/features/oracle/use-market-clock";
import { deriveOracleSafety, ORACLE_LIFECYCLE_EVENT_KINDS } from "@/lib/oracle-safety";
import { MarketBar, MarketPanel } from "./market-panel";
import { OrderBookDisplay } from "./order-book";
import { DEFAULT_TICKET, OrderTicket, sizeTicket, type Ticket } from "./order-ticket";
import { LifecyclePanel } from "./lifecycle-panel";
import { ActivityDrawer } from "./activity-drawer";
import { ErTxPanel, rollupExplorer } from "./er-tx-panel";
import { InstantTradingCard } from "./instant-trading-card";
import { Spinner } from "@/components/ui/spinner";
import { useV3Book } from "./use-v3-book";
import { RESOLUTIONS, useCandles } from "./use-candles";
import { refreshWalletBalances, useWalletBalances } from "@/features/portfolio/use-wallet-balances";
import { useOpenOrders } from "@/features/orders/use-open-orders";
import { OpenOrdersPanel } from "@/features/orders/open-orders-panel";
import { createV3OpenOrdersAdapter, unimplementedOpenOrdersAdapter } from "@/lib/open-orders";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { recordSignature } from "@/lib/last-signature";
import { claimTestFunds } from "@/lib/faucet-client";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { isReporterPriced, MM_SERVICE_URL, PRIMARY_MARKET, V3_MARKETS, v3MarketFor } from "@/lib/v3-markets";
import { MARKET_BY_SYMBOL } from "@/lib/markets";
import { SolanaRpcTransport } from "@/lib/rpc-transport";
import { marketStreamEvents } from "@/lib/market-stream-events";
import { buildV3OrderInstructions } from "./v3-order";
import { firstFreeSeat, seatFromPositions } from "./rollup-seat";
import { TxToasts, useTxToasts } from "./tx-toasts";

const marketApiUrl = publicMarketApiUrl;
const ONBOARDING_DEPOSIT = 100_000_000n; // 100 test USDC
/** Pre-IPO shares trade in the hundreds to thousands of dollars: 500 test USDC buys at least one at 5×. */
const PRE_IPO_ONBOARDING_DEPOSIT = 500_000_000n;
const publicDemoReadOnly = process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_EQUINOX_DEMO_READ_ONLY !== "false";

interface MarketEvent { kind: string; sequence?: number; payload: { kind?: string } }

export function TradingTerminal() {
  const auth = useAppAuth();
  const [ticket, setTicket] = useState<Ticket>(DEFAULT_TICKET);
  const pickBookPrice = useCallback((price: number) => {
    setTicket((current) => ({ ...current, kind: "limit", price: price.toFixed(2) }));
  }, []);
  // Wallet orders never block the button: several can be in flight at once.
  const [ordersInFlight, setOrdersInFlight] = useState(0);
  const orderPending = ordersInFlight > 0;
  const txToasts = useTxToasts();
  const [cancelPending, setCancelPending] = useState(false);
  const [faucetPending, setFaucetPending] = useState(false);
  const [notice, setNotice] = useState("Orders run in the MagicBlock rollup against an on-chain verified price, with USDC custody in the vault on Solana.");
  const [sessionActionReason, setSessionActionReason] = useState<SessionActionResult["reason"]>(null);
  const [marketSymbol, setMarketSymbol] = useState(process.env.NEXT_PUBLIC_EQUINOX_MARKET_SYMBOL ?? PRIMARY_MARKET.symbol);
  const [latestLifecycleEventKind, setLatestLifecycleEventKind] = useState<string | null>(null);
  const lifecycleEventRef = useRef<{ sequence: number; kind: string } | null>(null);
  const [nowUnixSeconds, setNowUnixSeconds] = useState(0);
  useEffect(() => {
    // Date.now() must never be called during render (react-hooks/purity) --
    // this is the only source of "now" for the oracle-safety staleness
    // check below, ticking often enough that a market going stale is
    // reflected within a few seconds of crossing the threshold.
    const tick = () => setNowUnixSeconds(Math.floor(Date.now() / 1000));
    tick();
    const interval = setInterval(tick, 5_000);
    return () => clearInterval(interval);
  }, []);
  // Deep links (`/trade?market=OPENAI-PERP`, e.g. from the Pre-IPO page) pick the market after hydration.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("market");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of the URL on mount
    if (wanted && V3_MARKETS.some((market) => market.symbol === wanted)) setMarketSymbol(wanted);
  }, []);
  // The live V3 market (its core, snapshot and price source) drives every read and write.
  const v3 = v3MarketFor(marketSymbol);
  // Legacy per-symbol config (V2 fixtures); pre-IPO symbols have none, so they borrow TSLA's.
  const marketConfig = MARKET_BY_SYMBOL.get(marketSymbol) ?? marketForSymbol(PRIMARY_MARKET.symbol);
  // Pre-IPO prices have no Pyth history: their candles come from the market-maker service.
  const candlesApiUrl = isReporterPriced(v3) ? MM_SERVICE_URL : marketApiUrl;
  const marketAddress = v3.core || null;
  // The in-app trading key (lib/trading-key.ts) is the trader: it signs seats,
  // deposits, orders and withdrawals silently once the wallet unlocked it.
  const tradingKey = useTradingKey(auth);
  const trader = tradingKey.signer?.address ?? auth.walletAddress;
  const traderAuth = tradingKey.signer
    ? { privyAuthenticated: false, getAccessToken: async () => null, signMessage: (_address: string, bytes: Uint8Array) => tradingKey.signer!.signMessage(bytes) }
    : auth;
  const protocol = useEquinoxProtocol(auth.authenticated ? marketAddress : null, tradingKey.signer, v3);
  // V3: each wallet uses its own seat (or the first free one), never seat 0 by default.
  const position = usePosition(protocol?.rpc ?? null, marketAddress, 0, { marketApiUrl, core: v3.core, ...(v3.core ? { trader: trader ?? null } : {}) });
  const l1SeatIndex = position.seatIndex ?? 0;
  const session = useTradingSession(protocol, trader, marketAddress, l1SeatIndex);
  const handleSessionResult = (result: SessionActionResult) => { setNotice(result.detail ? `${result.message}: ${result.detail}` : result.message); setSessionActionReason(result.reason); };
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const v3MarketState = useV3MarketState(marketApiUrl, v3.core);
  const sessionOrder = useSessionOrder(protocol?.rpc ?? null, session.status, auth, handleSessionResult, session.advanceNonce, executionStatus);
  const canTrade = session.status !== null && isSessionUsable(session.status);
  const v3Core = v3.core;
  const openOrdersAdapter = useMemo(
    () => marketApiUrl && v3Core
      ? createV3OpenOrdersAdapter({ marketApiUrl, core: v3Core })
      : unimplementedOpenOrdersAdapter,
    [v3Core],
  );
  const openOrders = useOpenOrders(openOrdersAdapter, marketAddress, l1SeatIndex);
  // The oracle clock is public chain state: read it before sign-in too.
  const readRpc = useMemo(() => new SolanaRpcTransport(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet"), []);
  const marketClock = useMarketClock(
    v3.oracleSnapshot ? readRpc : protocol?.rpc ?? null,
    v3.oracleSnapshot ? v3.core || null : marketAddress,
    v3.oracleSnapshot,
  );
  const oracleSafety = deriveOracleSafety({
    oracleValid: marketClock?.oracleValid ?? null,
    lastVerifiedOracleTimestamp: marketClock?.lastVerifiedOracleTimestamp ?? null,
    nowUnixSeconds,
    latestLifecycleEventKind,
  });
  const withdraw = useWithdraw(protocol, setNotice);
  // The main wallet's own signer, for collateral left in a seat the wallet itself owns.
  const walletProtocol = useEquinoxProtocol(auth.authenticated ? marketAddress : null, undefined, v3);
  const walletWithdraw = useWithdraw(walletProtocol, setNotice);
  const deposit = useDeposit(protocol, setNotice);
  const withdrawGate = evaluateWithdrawGate(executionStatus, position.reconciliationStatus);
  // While the market trades in the rollup, withdrawals go through the rollup outbox, except mid-commit.
  const rollupWithdraw = !!executionStatus?.marketDelegated && !executionStatus.commitPending;
  const book = useV3Book(marketApiUrl, v3.core || undefined, executionStatus ? executionStatus.marketDelegated : null);
  // While delegated, the rollup is the source of truth for seats (the L1 copy
  // is frozen), so resolve the wallet's seat from the live bundle.
  const fromRollup = !!executionStatus?.marketDelegated && !!trader && book.updatedAt !== null;
  const rollupSeat = useMemo(() => (fromRollup ? seatFromPositions(book.positions, trader!) : null), [fromRollup, book.positions, trader]);
  const seatIndex = fromRollup ? rollupSeat?.index ?? firstFreeSeat(book.positions) : l1SeatIndex;
  const seat = fromRollup ? rollupSeat?.view ?? null : position.seat;
  // A signed-in trader whose seat has not been read yet (never "no seat" while unknown).
  const seatLoading = !!trader && (executionStatus === null || (executionStatus.marketDelegated && book.updatedAt === null));
  // Nothing to trade with yet (no seat, or an empty one): the ticket's button starts trading instead of placing an order.
  const needsFunding = auth.authenticated && !!executionStatus?.marketDelegated && !seatLoading
    && (!seat || (seat.availableCollateral === 0n && seat.basePosition === 0n && seat.openOrderCount === 0));
  const walletSeatView = useMemo(() => (fromRollup && tradingKey.signer && auth.walletAddress ? seatFromPositions(book.positions, auth.walletAddress) : null), [fromRollup, tradingKey.signer, auth.walletAddress, book.positions]);
  const walletSeat = walletSeatView ? { index: walletSeatView.index, available: walletSeatView.view.availableCollateral } : null;
  function withdrawWalletSeat() {
    if (!walletSeatView || !auth.walletAddress) return;
    const accounts = resolveCustodyAccounts(auth.walletAddress, marketAddress, marketConfig, walletSeatView.index, v3);
    if (accounts) void walletWithdraw.submitWithdraw(accounts, walletSeatView.view.availableCollateral, withdrawGate, walletSeatView.view, rollupWithdraw);
  }
  // While delegated, "my open orders" come straight from the live rollup book.
  const liveOpenOrders = useMemo((): typeof openOrders => {
    if (seatLoading) return { kind: "loading" };
    if (!fromRollup) return openOrders;
    const mine = rollupSeat ? book.orders.filter((order) => order.owner === rollupSeat.index) : [];
    return mine.length
      ? { kind: "ready", stale: false, orders: mine.map((order) => ({ ...order, tree: "fixed" as const, filledQuantity: 0n, expiresAt: order.expiresAt === 2n ** 64n - 1n ? null : order.expiresAt })) }
      : { kind: "empty" };
  }, [seatLoading, fromRollup, openOrders, rollupSeat, book.orders]);
  // The headline price is the verified Pyth snapshot; the book mid only stands in without one.
  const bookMid = book.bids[0] && book.asks[0] ? (book.bids[0].price + book.asks[0].price) / 2 : null;
  // A stale snapshot (it only refreshes when someone trades) is not the price:
  // then the freshest Pyth close stands in, and the market bar says so.
  const snapshotStale = !!marketClock && nowUnixSeconds - Number(marketClock.lastVerifiedOracleTimestamp) > 10;
  const latestClose = useCandles(candlesApiUrl, marketSymbol, RESOLUTIONS[0], null).candles.at(-1)?.c ?? null;
  const indexPrice = snapshotStale && latestClose !== null ? latestClose : marketClock?.oracle?.price ?? latestClose;
  const markPrice = indexPrice ?? bookMid;
  const sized = sizeTicket(ticket, markPrice, marketConfig.initialMarginBps);
  const quantity = BigInt(sized?.shares ?? 0);
  const orderTypeFor = (t: Ticket) => (t.kind === "market" ? "ioc" : t.postOnly ? "post-only" : "limit");
  const walletCollateral = useMemo(() => resolveCustodyAccounts(trader, marketAddress, marketConfig, seatIndex, v3)?.sourceOrDestination?.toString() ?? null, [trader, marketAddress, marketConfig, v3, seatIndex]);
  const balances = useWalletBalances(readRpc, trader, walletCollateral);

  useEffect(() => {
    if (!marketApiUrl) {
      return;
    }

    let stopped = false;
    const applyEvents = (events: MarketEvent[]) => {
      // Tracks the most recent oracle/market-lifecycle event kind (a fully
      // decoded, verified discriminator name -- see lib/oracle-safety.ts)
      // for the oracle safety banner. Never gated on a "book" event being
      // present in this same batch -- these are independent event kinds.
      for (const event of events) {
        // The live Worker can legitimately forward an undecodable/legacy
        // event with no payload (for example while a V3 shard is absent).
        // Treat that record as non-lifecycle data instead of allowing a
        // malformed stream message to tear down the terminal effect.
        const payload = event?.payload;
        if (!payload || typeof payload !== "object") continue;
        const kind = payload.kind;
        if (!kind || typeof event.sequence !== "number" || !ORACLE_LIFECYCLE_EVENT_KINDS.has(kind)) continue;
        if (!lifecycleEventRef.current || event.sequence > lifecycleEventRef.current.sequence) {
          lifecycleEventRef.current = { sequence: event.sequence, kind };
          setLatestLifecycleEventKind(kind);
        }
      }
    };

    void fetch(`${marketApiUrl}/v1/markets/${marketSymbol}/snapshot`)
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("snapshot unavailable")))
      .then((data: unknown) => {
        if (stopped) return;
        applyEvents(marketStreamEvents<MarketEvent>(data));
      })
      .catch(() => undefined);

    const socketUrl = new URL(`${marketApiUrl}/v1/markets/${marketSymbol}/stream`);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);
    socket.onmessage = (message) => {
      applyEvents(marketStreamEvents<MarketEvent>(JSON.parse(message.data)));
    };
    socket.onerror = () => undefined;
    return () => { stopped = true; socket.close(); };
  }, [marketSymbol]);

  async function runLifecycle(): Promise<boolean> {
    if (publicDemoReadOnly) { setNotice("Read-only Devnet demo: lifecycle writes are disabled."); return false; }
    if (!trader || !marketAddress || !protocol) { setNotice("Configure the market, sign in, and connect a wallet before creating a seat."); return false; }
    try {
      const v3Core = v3.core;
      if (v3Core) {
        // Seats are created wherever the bundle lives: on L1, or inside the
        // MagicBlock rollup while delegated. Never mid-transition.
        const domain = executionStatus?.orderRoutingDomain;
        if (domain !== "l1" && domain !== "er") {
          setNotice("CreateV3TraderSeat blocked: the V3 bundle is between L1 and the rollup right now.");
          return false;
        }
        const execution = deriveV3ExecutionAccounts(v3Core, trader);
        const seat = createV3TraderSeat({ core: v3Core, seatShards: execution.seatShards, eventShards: execution.eventShards, trader }, seatIndex);
        const preview: TransactionPreview = {
          instruction: "CreateV3TraderSeat",
          programId: seat.programId.toBase58(),
          accounts: seat.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
          status: "constructed",
        };
        if (domain === "er") {
          setNotice("Creating your seat in the MagicBlock rollup…");
          await protocol.service.executeEr(preview, [seat], [v3Core, ...execution.seatShards, ...execution.eventShards].map(String));
          setNotice(`Seat #${seatIndex} created in the rollup. Deposit USDC to start trading.`);
          return true;
        }
        setNotice("Submitting CreateV3TraderSeat…");
        const result = await protocol.service.executeL1(preview, [seat]);
        recordSignature("CreateV3TraderSeat", result.signature, "l1");
        setNotice(`CreateV3TraderSeat ${result.confirmation} — signature ${result.signature.slice(0, 8)}…${result.signature.slice(-8)}.`);
        return true;
      }
      const seat = createTraderSeat({ market: marketAddress, authority: trader }, 0);
      const scratchAddress = process.env.NEXT_PUBLIC_EQUINOX_SETTLEMENT_SCRATCH_ADDRESS ?? marketConfig.scratchPda(0);
      const scratch = scratchAddress ? initializeSettlementScratch({ market: marketAddress, authority: trader, settlementScratch: scratchAddress }, 0) : null;
      setNotice(`Constructed ${scratch ? "CreateTraderSeat + InitializeSettlementScratch" : "CreateTraderSeat"} (${seat.keys.length + (scratch?.keys.length ?? 0)} account metas). V2 lifecycle writes remain preview-only.`);
      return false;
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not construct lifecycle action"); return false; }
  }

  function constructVault() {
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before initializing custody."); return; }
    const mint = process.env.NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT;
    const tokenProgram = process.env.NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM;
    const vault = process.env.NEXT_PUBLIC_EQUINOX_VAULT ?? marketConfig.vaultPda;
    const vaultAuthority = process.env.NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY;
    if (!mint || !tokenProgram || !vault || !vaultAuthority) { setNotice("Vault initialization blocked: explicit collateral deployment configuration is missing."); return; }
    const ix = initializeVault({ market: marketAddress, authority: auth.walletAddress, mint, tokenProgram, vault, vaultAuthority });
    setNotice(`Constructed InitializeVault with ${ix.keys.length} accounts. Token CPI runtime remains unavailable in this environment.`);
  }

  /** Legacy (V2) session orders price in the 1e6 book scale. */
  const sessionOrderFields = () => ({
    settlementScratch: process.env.NEXT_PUBLIC_EQUINOX_SETTLEMENT_SCRATCH_ADDRESS ?? marketConfig.scratchPda(0),
    side: (ticket.side === "long" ? "bid" : "ask") as "bid" | "ask",
    tree: "fixed" as OrderTree,
    postOnly: orderTypeFor(ticket) === "post-only",
    immediateOrCancel: orderTypeFor(ticket) === "ioc",
    reduceOnly: ticket.reduceOnly,
    quantity,
    priceOrOffset: BigInt(Math.round((Number(sized?.limitPriceUsd) || 0) * 1_000_000)),
    clientOrderId: BigInt(Date.now()),
  });

  // Shared by the manual order-key form and OpenOrdersPanel's per-row Replace:
  // both replace with the CURRENT ticket (replace is place-with-a-cancel).
  /** Cancels one order (or up to 8) straight in the rollup, signed by the trading key. */
  async function cancelV3(orderKey: bigint | null) {
    if (!protocol || !trader || !v3.core || !v3.oracleSnapshot || !seat) return;
    const execution = { ...deriveV3ExecutionAccounts(v3.core, trader), oracleSnapshot: v3.oracleSnapshot };
    const ix = orderKey === null ? cancelAllV3(execution, seatIndex, 8) : cancelOrderV3(execution, seatIndex, orderKey);
    const preview: TransactionPreview = { instruction: orderKey === null ? "CancelAll" : "CancelOrder", programId: ix.programId.toBase58(), accounts: ix.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })), status: "constructed" };
    setCancelPending(true);
    try {
      await protocol.service.executeEr(preview, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix], [execution.core, ...execution.bookPages, ...execution.seatShards, ...execution.eventShards].map(String));
      setNotice(orderKey === null ? "Cancelled your open orders." : "Order cancelled.");
    } catch (error) {
      setNotice(`Cancel failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCancelPending(false);
    }
  }

  function replaceWithCurrentTicket(orderKey: bigint) {
    void sessionOrder.replaceSessionOrder(orderKey, sessionOrderFields());
  }

  /** Main-wallet V3 order: routed to MagicBlock ER while the market is delegated, else L1. */
  async function placeV3Order() {
    if (!protocol || !trader || !v3.core || !v3.oracleSnapshot || !sized) return;
    if (!seat) { setNotice("Create your seat and deposit collateral before placing an order."); return; }
    if (!marketClock) { setNotice("Waiting for the verified price before placing an order."); return; }
    const built = buildV3OrderInstructions({
      core: v3.core, wallet: trader, oracleSnapshot: v3.oracleSnapshot, seatIndex,
      side: ticket.side === "long" ? "bid" : "ask", orderType: orderTypeFor(ticket), reduceOnly: ticket.reduceOnly, quantity,
      limitPriceUsd: sized.limitPriceUsd, expiresInMinutes: Number(ticket.expiresInMinutes) || 0, oracleClock: marketClock.lastVerifiedOracleTimestamp,
    });
    if ("error" in built) { setNotice(built.error); return; }
    const [, order] = built.instructions;
    const preview: TransactionPreview = { instruction: "PlaceOrder", programId: order.programId.toBase58(), accounts: order.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })), status: "constructed" };
    setOrdersInFlight((n) => n + 1);
    const what = `${ticket.side === "long" ? "Buy" : "Sell"} ${quantity} TSLA${orderTypeFor(ticket) === "ioc" ? "" : ` @ ${Number(sized.limitPriceUsd).toFixed(2)}`}`;
    const clicked = performance.now();
    const toastId = txToasts.push({ ok: true, pending: true, title: `${what} · sending…` });
    try {
      // The indexer's live execution status already says where the market lives: no extra round trip.
      if (executionStatus?.orderRoutingDomain === "er") {
        setNotice("Placing your order in the MagicBlock rollup…");
        const result = await protocol.service.executeEr(preview, built.instructions, built.writableAccounts);
        const ms = Math.round(performance.now() - clicked);
        setNotice("Order accepted by the MagicBlock rollup.");
        txToasts.settle(toastId, { ok: true, title: `${what} · done`, detail: `Finalized in the rollup · ${ms} ms from click`, href: result.signature ? rollupExplorer(result.signature) : undefined });
      } else {
        setNotice("Placing your order on Solana L1 (the market is not delegated right now)…");
        const result = await protocol.service.executeL1(preview, built.instructions, { freshOracle: true });
        recordSignature("PlaceOrder", result.signature, "l1");
        setNotice(`Order ${result.confirmation} on L1.`);
        txToasts.settle(toastId, { ok: true, title: `${what} · ${result.confirmation} on Solana`, href: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(`Order not placed: ${message}`);
      txToasts.settle(toastId, { ok: false, title: `${what} · not placed`, detail: message });
    } finally {
      setOrdersInFlight((n) => n - 1);
    }
  }

  function submitOrder() {
    if (!auth.authenticated) { openWalletDrawer(); return; }
    if (publicDemoReadOnly) { setNotice("Read-only Devnet demo: live order submission is unavailable."); return; }
    if (needsFunding) { void startTrading(onboardingDeposit); return; }
    if (!canTrade && walletTrading) { void placeV3Order(); return; }
    if (canTrade) {
      const minutes = Number(ticket.expiresInMinutes) || 0;
      if (minutes > 0 && !marketClock?.oracleValid) { setNotice("Cannot set an order expiration: the market's oracle clock is unavailable."); return; }
      void sessionOrder.placeSessionOrder({
        ...sessionOrderFields(),
        // Anchored to the market's oracle-verified clock, which the program reads as "now" for expiry.
        expiresAt: minutes > 0 && marketClock ? marketClock.lastVerifiedOracleTimestamp + BigInt(minutes * 60) : undefined,
      });
      return;
    }
    const fields = sessionOrderFields();
    if (!marketAddress || !auth.walletAddress || !fields.settlementScratch) { setNotice("Preview unavailable: configure market and settlement scratch addresses. No transaction was created."); return; }
    try {
      const preview = previewPlaceOrder({ market: marketAddress, authority: auth.walletAddress, settlementScratch: fields.settlementScratch, seatIndex: 0, side: fields.side, quantity, priceOrOffset: fields.priceOrOffset, clientOrderId: 0n });
      setNotice(`Unsigned ${preview.instruction} preview: ${preview.accounts.length} accounts, ${preview.signers.length} signer, margin ${preview.estimatedInternalMargin}. Authorize a trading session to submit for real.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not construct order preview"); }
  }

  // V3 orders can be signed by the main wallet directly (no session key needed).
  const walletTrading = !!v3.core && !!v3.oracleSnapshot && auth.authenticated && !!protocol;
  const live = marketClock?.oracle ? { price: marketClock.oracle.price, publishTime: Number(marketClock.lastVerifiedOracleTimestamp) } : null;
  const oracleAgeSeconds = marketClock && nowUnixSeconds ? Math.max(0, nowUnixSeconds - Number(marketClock.lastVerifiedOracleTimestamp)) : null;

  /** Devnet faucet: 1,000 test USDC (and a little SOL for fees) to the signed-in wallet. */
  async function claimFunds() {
    if (!trader) { openWalletDrawer(); return; }
    setFaucetPending(true);
    setNotice("Sending test funds…");
    try { setNotice(await claimTestFunds(traderAuth, trader)); } finally { setFaucetPending(false); refreshWalletBalances(); }
  }

  /** One click from a connected wallet to a funded seat, and the path every
   * Deposit takes: unlock the trading key (the only wallet prompt, once per
   * device), then faucet if short → seat if missing → deposit, all signed
   * silently by the trading key. */
  const [onboarding, setOnboarding] = useState<string | null>(null);
  const [autoStart, setAutoStart] = useState<bigint | null>(null);
  // The book feed can lag a just-created seat; never create it twice in a session.
  const seatCreatedFor = useRef<string | null>(null);
  // Computed per render and passed explicitly: a default parameter reading the
  // selected market was frozen at the first render by the compiler's memoization.
  const onboardingDeposit = v3.kind === "pre-ipo" ? PRE_IPO_ONBOARDING_DEPOSIT : ONBOARDING_DEPOSIT;
  async function startTrading(amount: bigint) {
    if (!auth.walletAddress) { openWalletDrawer(); return; }
    if (publicDemoReadOnly) { setNotice("Read-only Devnet demo: onboarding is unavailable."); return; }
    if (!tradingKey.signer) {
      setOnboarding("Unlocking trading account…");
      try { await tradingKey.unlock(); setAutoStart(amount); }
      catch (error) { setNotice(`Trading account not unlocked: ${error instanceof Error ? error.message : String(error)}`); }
      finally { setOnboarding(null); }
      return;
    }
    if (!protocol || !trader || !walletCollateral) return;
    if (seatLoading) { setNotice("Loading your seat — try again in a moment."); return; }
    const hasSeat = !!seat || seatCreatedFor.current === trader;
    try {
      let usdc = await readRpc.tokenBalance(walletCollateral).catch(() => 0n);
      const sol = await readRpc.solBalance(trader).catch(() => 0n);
      if (usdc < amount || sol < 10_000_000n) {
        setOnboarding("1/3 · Funding…");
        setNotice("1/3 · Funding your trading account with test USDC and SOL…");
        const message = await claimTestFunds(traderAuth, trader);
        refreshWalletBalances();
        for (let attempt = 0; attempt < 30 && usdc < amount; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          usdc = await readRpc.tokenBalance(walletCollateral).catch(() => 0n);
        }
        refreshWalletBalances();
        if (usdc < amount) { setNotice(message); return; }
      }
      if (!hasSeat) {
        setOnboarding("2/3 · Creating seat…");
        if (!(await runLifecycle())) return;
        seatCreatedFor.current = trader;
      }
      setOnboarding("3/3 · Depositing…");
      const accounts = resolveCustodyAccounts(trader, marketAddress, marketConfig, seatIndex, v3);
      if (accounts) await deposit.submitDeposit(accounts, amount, executionStatus?.marketDelegated ?? false);
    } finally {
      setOnboarding(null);
      refreshWalletBalances();
    }
  }
  useEffect(() => {
    if (autoStart === null || !protocol || !tradingKey.signer) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoStart(null);
    void startTrading(autoStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, protocol, tradingKey.signer]);


  // Pyth reports the US session closed: the program refuses every order until it reopens.
  const marketClosed = marketClock?.oracle ? !marketClock.oracle.tradingOpen : false;
  // Anything signing or confirming right now: its label greys out every other action.
  const busy = onboarding
    ?? (tradingKey.unlocking ? "Waiting for your wallet signature…" : null)
    ?? (deposit.pending ? "Depositing…" : null)
    ?? (withdraw.pending || walletWithdraw.pending ? "Withdrawing…" : null)
    ?? (orderPending || sessionOrder.pending ? "Placing your order in the rollup…" : null)
    ?? (cancelPending ? "Cancelling in the rollup…" : null)
    ?? (faucetPending ? "Sending test funds…" : null);
  const blocker = busy && !orderPending ? busy : needsFunding ? null : marketClosed && auth.authenticated ? "Market closed — US session only" : !auth.authenticated
    ? null
    : !sized
      ? ticket.kind === "limit" && !(Number(ticket.price) > 0) ? "Enter a limit price" : markPrice === null ? "Waiting for the verified price" : "Enter an amount"
      : sized.shares <= 0 ? "Below one share" : null;
  const tickerName = marketSymbol.replace("-PERP", "");
  const ctaLabel = !auth.authenticated
    ? "Sign in to trade"
    : needsFunding
      ? `Start trading · deposit $${Number(onboardingDeposit) / 1e6}`
      : `${canTrade || walletTrading ? "Place order" : "Preview order"} · ${ticket.side === "long" ? "Long" : "Short"} ${sized?.shares ?? 0} ${tickerName}`;
  const available = seat ? Number(seat.availableCollateral) / 1e6 : null;

  const guard = (action: string, run: () => void) => () => { if (publicDemoReadOnly) { setNotice(`Read-only Devnet demo: ${action} is unavailable.`); return; } run(); };
  const onCancelOrder = (orderKey: bigint) => guard("order cancellation", () => void (walletTrading && !canTrade ? cancelV3(orderKey) : sessionOrder.cancelSessionOrder(orderKey)))();
  // Keep an order's prerequisites (delegation check, blockhash, price age) warm:
  // a click then only signs and sends.
  const orderAccounts = useMemo(() => {
    if (!v3.core || !trader) return null;
    const execution = deriveV3ExecutionAccounts(v3.core, trader);
    return [execution.core, ...execution.bookPages, ...execution.seatShards, ...execution.eventShards].map(String);
  }, [trader, v3.core]);
  useEffect(() => {
    if (!protocol || !orderAccounts || !executionStatus?.marketDelegated) return;
    const warm = () => { if (!document.hidden) protocol.service.warm(orderAccounts); };
    warm();
    const timer = setInterval(warm, 800);
    return () => clearInterval(timer);
  }, [protocol, orderAccounts, executionStatus?.marketDelegated]);

  const onCancelAllOrders = guard("order cancellation", () => void (walletTrading && !canTrade ? cancelV3(null) : sessionOrder.cancelAllSessionOrders(4)));

  return (
    <div className="terminal flex min-h-screen flex-col xl:h-screen xl:overflow-hidden">
      <TopBar active="trade" auth={auth} />
      <MarketBar
        marketSymbol={marketSymbol}
        onMarketSymbolChange={setMarketSymbol}
        marketApiUrl={candlesApiUrl}
        live={live}
        price={indexPrice}
        oracle={marketClock?.oracle ?? null}
        oracleAgeSeconds={oracleAgeSeconds}
      />

      <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none xl:flex-row">
        {/* Chart + activity. Owns the slack at xl; fixed height while stacked. */}
        <div className="tk-col order-2 flex min-h-0 min-w-0 flex-col xl:order-none xl:flex-1">
          <div className="h-[560px] shrink-0 overflow-hidden xl:h-auto xl:min-h-0 xl:flex-1">
            <MarketPanel marketSymbol={marketSymbol} marketApiUrl={candlesApiUrl} live={live} depth={book} />
          </div>
          <ActivityDrawer
            aside={<ErTxPanel key={v3.symbol} marketApiUrl={marketApiUrl} market={v3.symbol} />}
            loading={seatLoading}
            signedIn={!!trader}
            seat={seat}
            seatError={position.error}
            seatIndex={trader && seat ? seatIndex : null}
            symbol={marketSymbol}
            markPrice={markPrice}
            trades={book.trades}
            openOrders={
              <OpenOrdersPanel
                state={liveOpenOrders}
                pending={sessionOrder.pending}
                onCancel={onCancelOrder}
                onReplace={(orderKey) => guard("order replacement", () => replaceWithCurrentTicket(orderKey))()}
                onCancelAll={onCancelAllOrders}
              />
            }
          />
        </div>

        {/* Depth. */}
        <div className="tk-col order-3 flex h-[560px] w-full shrink-0 flex-col xl:order-none xl:h-auto xl:w-[320px]">
          <OrderBookDisplay book={book} symbol={marketSymbol} marketClosed={marketClosed} onPickPrice={pickBookPrice} />
        </div>

        {/* Entry, wallet, and system truth. */}
        <div className="tk-col slim-scroll order-1 flex w-full shrink-0 flex-col xl:order-none xl:w-[340px] xl:overflow-y-auto">
          <OrderTicket
            ticket={ticket}
            onChange={setTicket}
            ticker={tickerName}
            markPrice={markPrice}
            maxLeverage={marketConfig.maximumLeverage}
            initialMarginBps={marketConfig.initialMarginBps}
            availableUsd={available}
            ctaLabel={ctaLabel}
            blocker={blocker}
            pending={sessionOrder.pending}
            footnote={canTrade ? `Session key active — orders sign locally, no wallet popup.` : walletTrading ? "Orders sign with your wallet and route to the MagicBlock rollup while the market is delegated." : "Sign in, then Start trading: one wallet signature and the in-app trading account signs every order silently."}
            onSubmit={submitOrder}
          />
          <div className="notice flex items-start gap-2 border-b border-[var(--t-border)] px-3 py-2.5 text-[11.5px] leading-snug text-[var(--t-text-2)]" role="status">
            {busy ? <Spinner className="mt-px h-3.5 w-3.5 text-[var(--t-up)]" /> : null}
            <span>{notice}</span>
            {sessionActionReason ? <span className="text-[var(--t-down)]"> [{sessionActionReason}]</span> : null}
          </div>
          <LifecyclePanel
            walletAddress={trader}
            privyLabel={tradingKey.signer ? "in-app trading account · signs silently" : [auth.userLabel, auth.walletClientType === "privy" ? "embedded wallet" : auth.walletClientType].filter(Boolean).join(" · ") || "wallet"}
            onSignIn={openWalletDrawer}
            walletUsdc={balances.collateralTokenBalance}
            walletSol={balances.solLamports}
            seat={seat}
            seatIndex={seat ? seatIndex : null}
            seatLoading={seatLoading}
            onSeatAndScratch={() => void runLifecycle()}
            onStartTrading={() => void startTrading(onboardingDeposit)}
            onboarding={onboarding ?? (tradingKey.unlocking ? "Waiting for wallet signature…" : null)}
            busy={busy}
            seatActionLabel="Create V3 seat"
            onFaucet={v3.core ? () => void claimFunds() : undefined}
            onDeposit={(units) => guard("deposits", () => {
              // Never guess the path: the market's location decides who signs.
              if (!executionStatus) { setNotice("Checking where the market runs — try again in a moment."); return; }
              // Deposits into the rollup always go through the trading key: never a wallet popup per step.
              if (executionStatus.marketDelegated) { void startTrading(units); return; }
              const accounts = resolveCustodyAccounts(trader, marketAddress, marketConfig, seatIndex, v3);
              if (!accounts) { setNotice("Sign in before depositing."); return; }
              void deposit.submitDeposit(accounts, units, false);
            })()}
            onWithdraw={(units) => guard("withdrawals", () => {
              const accounts = resolveCustodyAccounts(trader, marketAddress, marketConfig, seatIndex, v3);
              if (!accounts) { setNotice("Sign in before withdrawing."); return; }
              void withdraw.submitWithdraw(accounts, units, withdrawGate, seat, rollupWithdraw, tradingKey.signer ? auth.walletAddress : null);
            })()}
            withdrawDisabled={!withdrawGate.allowed && !rollupWithdraw}
            withdrawReason={withdrawGate.allowed || rollupWithdraw ? null : withdrawGate.reason ?? null}
            rollupLive={executionStatus?.marketDelegated ?? false}
            onInitializeVault={constructVault}
            onCancelAll={onCancelAllOrders}
            onCancelOrder={onCancelOrder}
            onReplaceOrder={(orderKey) => guard("order replacement", () => replaceWithCurrentTicket(orderKey))()}
          />
          {/* Live V3 wallet trading uses the in-app trading key. User sessions only exist for
              markets on L1 authorized by the market authority, so that panel stays for the fixture. */}
          {v3.oracleSnapshot ? (auth.walletAddress ? <div className="border-t border-[var(--t-border)]">
            <InstantTradingCard
              tradingAddress={tradingKey.signer?.address ?? null}
              unlocking={tradingKey.unlocking}
              onEnable={() => void tradingKey.unlock().catch((error: unknown) => setNotice(`Trading account not unlocked: ${error instanceof Error ? error.message : String(error)}`))}
              walletSeat={walletSeat}
              walletSeatBusy={walletWithdraw.pending}
              onWithdrawWalletSeat={withdrawWalletSeat}
              disabled={!!busy}
            />
          </div> : null) : <div className="border-t border-[var(--t-border)]">
            <SessionPolicyPanel
              status={session.status}
              pending={session.pending}
              error={session.error}
              onAuthorize={(config) => guard("Privy session relay", () => void session.authorize(config))()}
              onRevoke={guard("session writes", () => void session.revoke())}
            />
          </div>}
          <div className="border-t border-[var(--t-border)]">
            <ExecutionStatusBanner display={executionStatus} canTrade={canTrade} walletTrading={walletTrading} oracleSafety={oracleSafety} v3={v3MarketState} privy={tradingKey.signer ? "in-app trading key · silent signing" : auth.walletAddress ? `${auth.userLabel ?? "wallet login"} · ${auth.walletClientType === "privy" ? "embedded wallet" : auth.walletClientType ?? "wallet"}` : auth.wallets.length ? "sign-in incomplete" : "not signed in"} />
          </div>
        </div>
      </main>

      <ProtocolStatusStrip authenticated={auth.authenticated} v3={v3MarketState} delegated={executionStatus ? executionStatus.marketDelegated : null} oracleOnline={oracleSafety === "fresh"} priceSource={isReporterPriced(v3) ? "reporter" : "pyth"} />
      <TxToasts toasts={txToasts.toasts} />
    </div>
  );
}
