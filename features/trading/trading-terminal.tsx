"use client";

import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { ExecutionStatusBanner, ProtocolStatusStrip } from "@/components/layout/status-strip";
import { useAppAuth } from "@/components/app-providers";
import { isSessionUsable } from "@/lib/session-trading";
import { createTraderSeat, initializeSettlementScratch, initializeVault, previewPlaceOrder } from "@/clients/stockstream/src";
import { marketForSymbol } from "@/lib/markets";
import { useWithdraw, evaluateWithdrawGate } from "@/features/collateral/use-withdraw";
import { useDeposit } from "@/features/collateral/use-deposit";
import { resolveCustodyAccounts } from "@/features/collateral/custody-accounts";
import { useStockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useSessionOrder } from "@/features/sessions/use-session-order";
import { SessionPolicyPanel } from "@/features/sessions/session-policy-panel";
import type { SessionActionResult } from "@/lib/session-relay-status";
import type { OrderTree } from "@/clients/stockstream/src";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { usePosition } from "@/features/positions/use-position";
import { PositionsPanel } from "@/features/positions/positions-panel";
import { useMarketClock } from "@/features/oracle/use-market-clock";
import { decimal } from "./format";
import { MarketPanel } from "./market-panel";
import { OrderBookPanel, type BookLevel } from "./order-book";
import { OrderTicket } from "./order-ticket";
import { LifecyclePanel } from "./lifecycle-panel";
import { LaunchLab } from "@/features/launch/launch-lab";

const marketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL;

interface MarketEvent { kind: string; payload: { bids?: BookLevel[]; asks?: BookLevel[] }; }

export function TradingTerminal() {
  const auth = useAppAuth();
  const [side, setSide] = useState<"short" | "long">("short");
  const [tab, setTab] = useState<"trade" | "launch">("trade");
  const [quantity, setQuantity] = useState("12");
  const [limitPrice, setLimitPrice] = useState("");
  const [orderType, setOrderType] = useState<"limit" | "post-only" | "ioc" | "oracle-pegged">("limit");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [expiresInMinutes, setExpiresInMinutes] = useState("");
  const [notice, setNotice] = useState("Live submission requires verified Pyth pricing, USDC custody and MagicBlock delegation.");
  const [sessionActionReason, setSessionActionReason] = useState<SessionActionResult["reason"]>(null);
  const [marketSymbol, setMarketSymbol] = useState(process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? "AAPL-PERP");
  const [book, setBook] = useState<{ bids: BookLevel[]; asks: BookLevel[] }>({ bids: [], asks: [] });
  const [marketFeedStatus, setMarketFeedStatus] = useState<"connecting" | "live" | "unavailable">(marketApiUrl ? "connecting" : "unavailable");
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS ?? marketConfig.marketPda;
  const protocol = useStockStreamProtocol(auth.authenticated ? marketAddress : null);
  const session = useTradingSession(protocol, auth.walletAddress, marketAddress, 0);
  const handleSessionResult = (result: SessionActionResult) => { setNotice(result.detail ? `${result.message}: ${result.detail}` : result.message); setSessionActionReason(result.reason); };
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const sessionOrder = useSessionOrder(protocol?.rpc ?? null, session.status, auth, handleSessionResult, session.advanceNonce, executionStatus);
  const canTrade = session.status !== null && isSessionUsable(session.status);
  const position = usePosition(protocol?.rpc ?? null, marketAddress, 0);
  const marketClock = useMarketClock(protocol?.rpc ?? null, marketAddress);
  const withdraw = useWithdraw(protocol);
  const deposit = useDeposit(protocol);
  const withdrawGate = evaluateWithdrawGate(executionStatus, position.reconciliationStatus);
  const quantityNumber = Number(quantity) || 0;
  const bestBid = book.bids[0] ? decimal(book.bids[0].price, 1_000_000) : Number.NaN;
  const bestAsk = book.asks[0] ? decimal(book.asks[0].price, 1_000_000) : Number.NaN;
  const markPrice = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : Number.NaN;
  const notional = Number.isFinite(markPrice) ? quantityNumber * markPrice : Number.NaN;

  useEffect(() => {
    if (!marketApiUrl) {
      return;
    }

    let stopped = false;
    const applyEvents = (events: MarketEvent[]) => {
      const latestBook = [...events].reverse().find((event) => event.kind === "book");
      if (!latestBook) return;
      setBook({ bids: latestBook.payload.bids ?? [], asks: latestBook.payload.asks ?? [] });
      setMarketFeedStatus("live");
    };

    void fetch(`${marketApiUrl}/v1/markets/${marketSymbol}/snapshot`)
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("snapshot unavailable")))
      .then((data: { events: MarketEvent[] }) => { if (!stopped) applyEvents(data.events); })
      .catch(() => { if (!stopped) setMarketFeedStatus("unavailable"); });

    const socketUrl = new URL(`${marketApiUrl}/v1/markets/${marketSymbol}/stream`);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as MarketEvent | { events: MarketEvent[] };
      if ("events" in data) applyEvents(data.events);
      else applyEvents([data]);
    };
    socket.onerror = () => { if (!stopped) setMarketFeedStatus("unavailable"); };
    return () => { stopped = true; socket.close(); };
  }, [marketSymbol]);

  function runLifecycle() {
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before constructing lifecycle actions."); return; }
    try {
      const seat = createTraderSeat({ market: marketAddress, authority: auth.walletAddress }, 0);
      const scratchAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_SETTLEMENT_SCRATCH_ADDRESS ?? marketConfig.scratchPda(0);
      const scratch = scratchAddress ? initializeSettlementScratch({ market: marketAddress, authority: auth.walletAddress, settlementScratch: scratchAddress }, 0) : null;
      setNotice(`Constructed ${scratch ? "CreateTraderSeat + InitializeSettlementScratch" : "CreateTraderSeat"} (${seat.keys.length + (scratch?.keys.length ?? 0)} account metas). Signing is disabled until the configured L1 transport is available.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not construct lifecycle action"); }
  }

  function constructVault() {
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before initializing custody."); return; }
    const mint = process.env.NEXT_PUBLIC_STOCKSTREAM_COLLATERAL_MINT;
    const tokenProgram = process.env.NEXT_PUBLIC_STOCKSTREAM_TOKEN_PROGRAM;
    const vault = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT ?? marketConfig.vaultPda;
    const vaultAuthority = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT_AUTHORITY;
    if (!mint || !tokenProgram || !vault || !vaultAuthority) { setNotice("Vault initialization blocked: explicit collateral deployment configuration is missing."); return; }
    const ix = initializeVault({ market: marketAddress, authority: auth.walletAddress, mint, tokenProgram, vault, vaultAuthority });
    setNotice(`Constructed InitializeVault with ${ix.keys.length} accounts. Token CPI runtime remains unavailable in this environment.`);
  }

  function submitOrder() {
    const settlementScratch = process.env.NEXT_PUBLIC_STOCKSTREAM_SETTLEMENT_SCRATCH_ADDRESS ?? marketConfig.scratchPda(0);
    if (canTrade) {
      const minutes = Number(expiresInMinutes) || 0;
      if (minutes > 0 && !marketClock?.oracleValid) { setNotice("Cannot set an order expiration: the market's oracle clock is unavailable."); return; }
      void sessionOrder.placeSessionOrder({
        settlementScratch,
        side: side === "long" ? "bid" : "ask",
        tree: (orderType === "oracle-pegged" ? "oracle-pegged" : "fixed") as OrderTree,
        postOnly: orderType === "post-only",
        immediateOrCancel: orderType === "ioc",
        reduceOnly,
        quantity: BigInt(quantityNumber),
        priceOrOffset: BigInt(limitPrice || 0),
        // Unix seconds, anchored to the market's own oracle-verified clock
        // (handlers.rs::place_order_core reads header.last_verified_oracle_
        // timestamp as "now" for expiry, not Clock::get() or wall-clock).
        expiresAt: minutes > 0 && marketClock ? marketClock.lastVerifiedOracleTimestamp + BigInt(minutes * 60) : undefined,
        clientOrderId: BigInt(Date.now()),
      });
      return;
    }
    if (!auth.authenticated) { setNotice("Sign in with Privy to construct a safe PlaceOrder preview. No transaction was created."); return; }
    if (!marketAddress || !auth.walletAddress || !settlementScratch) { setNotice("Preview unavailable: configure market and settlement scratch addresses. No transaction was created."); return; }
    try {
      const preview = previewPlaceOrder({ market: marketAddress, authority: auth.walletAddress, settlementScratch, seatIndex: 0, side: side === "long" ? "bid" : "ask", quantity: BigInt(quantityNumber), priceOrOffset: BigInt(limitPrice || 0), clientOrderId: 0n });
      setNotice(`Unsigned ${preview.instruction} preview: ${preview.accounts.length} accounts, ${preview.signers.length} signer, margin ${preview.estimatedInternalMargin}. Authorize a trading session to submit for real.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not construct order preview"); }
  }

  return (
    <main className="shell">
      <TopBar active={tab} onTabChange={setTab} auth={auth} />
      <ExecutionStatusBanner display={executionStatus} canTrade={canTrade} />
      <ProtocolStatusStrip marketSymbol={marketSymbol} onMarketSymbolChange={setMarketSymbol} authenticated={auth.authenticated} />

      {tab === "trade" ? (
        <div className="terminal-grid">
          <MarketPanel marketSymbol={marketSymbol} marketFeedStatus={marketFeedStatus} markPrice={markPrice} bestBid={bestBid} bestAsk={bestAsk} />
          <OrderBookPanel book={book} markPrice={markPrice} bestBid={bestBid} bestAsk={bestAsk} />
          <OrderTicket
            side={side}
            onSideChange={setSide}
            quantity={quantity}
            onQuantityChange={setQuantity}
            limitPrice={limitPrice}
            onLimitPriceChange={setLimitPrice}
            orderType={orderType}
            onOrderTypeChange={setOrderType}
            reduceOnly={reduceOnly}
            onReduceOnlyChange={setReduceOnly}
            expiresInMinutes={expiresInMinutes}
            onExpiresInMinutesChange={setExpiresInMinutes}
            markPrice={markPrice}
            notional={notional}
            authenticated={auth.authenticated}
            canTrade={canTrade}
            marketConfig={marketConfig}
            onSubmit={submitOrder}
          />
          <LifecyclePanel
            onSeatAndScratch={runLifecycle}
            onDeposit={() => {
              const accounts = resolveCustodyAccounts(auth.walletAddress, marketAddress, marketConfig);
              if (!accounts) { setNotice("Configure the market, collateral mint/vault addresses and sign in before depositing."); return; }
              void deposit.submitDeposit(accounts, BigInt(quantityNumber || 1));
            }}
            onWithdraw={() => {
              const accounts = resolveCustodyAccounts(auth.walletAddress, marketAddress, marketConfig);
              if (!accounts) { setNotice("Configure the market, collateral mint/vault addresses and sign in before withdrawing."); return; }
              void withdraw.submitWithdraw(accounts, BigInt(quantityNumber || 1), withdrawGate, position.seat);
            }}
            withdrawDisabled={!withdrawGate.allowed || withdraw.pending}
            onInitializeVault={constructVault}
            onCancelAll={() => void sessionOrder.cancelAllSessionOrders(4)}
            onCancelOrder={(orderKey) => void sessionOrder.cancelSessionOrder(orderKey)}
            onReplaceOrder={(orderKey) => {
              const settlementScratch = process.env.NEXT_PUBLIC_STOCKSTREAM_SETTLEMENT_SCRATCH_ADDRESS ?? marketConfig.scratchPda(0);
              void sessionOrder.replaceSessionOrder(orderKey, {
                settlementScratch,
                side: side === "long" ? "bid" : "ask",
                tree: (orderType === "oracle-pegged" ? "oracle-pegged" : "fixed") as OrderTree,
                postOnly: orderType === "post-only",
                immediateOrCancel: orderType === "ioc",
                reduceOnly,
                quantity: BigInt(quantityNumber),
                priceOrOffset: BigInt(limitPrice || 0),
                clientOrderId: BigInt(Date.now()),
              });
            }}
          />
          <SessionPolicyPanel
            status={session.status}
            pending={session.pending}
            error={session.error}
            onAuthorize={(config) => void session.authorize(config)}
            onRevoke={() => void session.revoke()}
          />
          <PositionsPanel seat={position.seat} error={position.error} />
          <div className="notice">
            <CircleAlert size={16} />
            <span>{withdraw.notice ?? deposit.notice ?? notice}</span>
            {sessionActionReason ? <span className="negative"> [{sessionActionReason}]</span> : null}
            {!withdrawGate.allowed ? <span className="muted"> · Withdrawals disabled: {withdrawGate.reason}</span> : null}
          </div>
        </div>
      ) : (
        <LaunchLab onLaunch={() => setNotice("DBC execution is not enabled until an issuer wallet and configured Meteora pool parameters are available. No launch was created.")} />
      )}
    </main>
  );
}
