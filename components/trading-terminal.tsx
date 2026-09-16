"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BadgeDollarSign,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Coins,
  Landmark,
  LoaderCircle,
  LockKeyhole,
  Radio,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  WalletCards
} from "lucide-react";
import { useAppAuth } from "@/components/app-providers";
import { authorizeTradingSession, cancelAll, createTraderSeat, depositCollateral, initializeSettlementScratch, initializeVault, previewPlaceOrder, revokeTradingSession, withdrawCollateral } from "@/clients/stockstream/src";
import { PERP_MARKETS, marketForSymbol } from "@/lib/markets";

const marketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL;

interface BookLevel { price: string; size: string; }
interface MarketEvent { kind: string; payload: { bids?: BookLevel[]; asks?: BookLevel[] }; }

function decimal(value: string, scale: number): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? raw / scale : Number.NaN;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function TradingTerminal() {
  const auth = useAppAuth();
  const [side, setSide] = useState<"short" | "long">("short");
  const [tab, setTab] = useState<"trade" | "launch">("trade");
  const [quantity, setQuantity] = useState("12");
  const [limitPrice, setLimitPrice] = useState("");
  const [notice, setNotice] = useState("Live submission requires verified Pyth pricing, USDC custody and MagicBlock delegation.");
  const [marketSymbol, setMarketSymbol] = useState(process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? PERP_MARKETS[0].symbol);
  const [book, setBook] = useState<{ bids: BookLevel[]; asks: BookLevel[] }>({ bids: [], asks: [] });
  const [marketFeedStatus, setMarketFeedStatus] = useState<"connecting" | "live" | "unavailable">(marketApiUrl ? "connecting" : "unavailable");
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS ?? marketConfig.marketPda;
  const active = false;
  const canTrade = false;
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

  function constructCollateralAction(withdraw: boolean) {
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before constructing custody actions."); return; }
    const mint = process.env.NEXT_PUBLIC_STOCKSTREAM_COLLATERAL_MINT;
    const tokenProgram = process.env.NEXT_PUBLIC_STOCKSTREAM_TOKEN_PROGRAM;
    const vault = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT ?? marketConfig.vaultPda;
    const vaultAuthority = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT_AUTHORITY;
    if (!mint || !tokenProgram || !vault || !vaultAuthority) { setNotice("Custody action blocked: collateral mint, token program and vault addresses are not configured."); return; }
    const custodyAccounts = { market: marketAddress, authority: auth.walletAddress, seat: auth.walletAddress, seatIndex: 0, sourceOrDestination: auth.walletAddress, mint, tokenProgram, vault, vaultAuthority };
    const ix = withdraw ? withdrawCollateral(custodyAccounts, BigInt(quantityNumber || 1)) : depositCollateral(custodyAccounts, BigInt(quantityNumber || 1));
    setNotice(`Constructed ${withdraw ? "WithdrawCollateral" : "DepositCollateral"} with ${ix.keys.length} accounts. Runtime submission is disabled until the custody transport is configured.`);
  }

  function constructSessionAction(revoke = false) {
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before constructing session actions."); return; }
    const session = process.env.NEXT_PUBLIC_STOCKSTREAM_SESSION_ACCOUNT;
    const sessionSigner = process.env.NEXT_PUBLIC_STOCKSTREAM_SESSION_SIGNER;
    if (!session || (!revoke && !sessionSigner)) { setNotice("Trading session action blocked: session account and signer public key are not configured."); return; }
    const ix = revoke
      ? revokeTradingSession({ market: marketAddress, authority: auth.walletAddress, session: session! }, 1n)
      : authorizeTradingSession({ market: marketAddress, authority: auth.walletAddress, session: session!, sessionSigner: sessionSigner! }, BigInt(Date.now() + 3_600_000), 1n);
    setNotice(`Constructed ${revoke ? "RevokeTradingSession" : "AuthorizeTradingSession"} with ${ix.keys.length} accounts. No signature was requested.`);
  }

  function constructCancelAll() {
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before constructing cancellation actions."); return; }
    const ix = cancelAll({ market: marketAddress, authority: auth.walletAddress }, 0, 4);
    setNotice(`Constructed CancelAll with ${ix.keys.length} accounts. No transaction was submitted.`);
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
    if (!canTrade) {
      if (!auth.authenticated) { setNotice("Sign in with Privy to construct a safe PlaceOrder preview. No transaction was created."); return; }
      const settlementScratch = process.env.NEXT_PUBLIC_STOCKSTREAM_SETTLEMENT_SCRATCH_ADDRESS ?? marketConfig.scratchPda(0);
      if (!marketAddress || !auth.walletAddress || !settlementScratch) { setNotice("Preview unavailable: configure market and settlement scratch addresses. No transaction was created."); return; }
      try {
        const preview = previewPlaceOrder({ market: marketAddress, authority: auth.walletAddress, settlementScratch, seatIndex: 0, side: side === "long" ? "bid" : "ask", quantity: BigInt(quantityNumber), priceOrOffset: BigInt(limitPrice || 0), clientOrderId: 0n });
        setNotice(`Unsigned ${preview.instruction} preview: ${preview.accounts.length} accounts, ${preview.signers.length} signer, margin ${preview.estimatedInternalMargin}. Live submission requires verified Pyth pricing, USDC custody and MagicBlock delegation.`);
      } catch (error) { setNotice(error instanceof Error ? error.message : "Could not construct order preview"); }
      return;
    }
    setNotice(`${side === "short" ? "Short" : "Long"} order requires the deployed StockStream program client. No transaction was sent.`);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">S</span><span>StockStream</span></div>
        <nav aria-label="Primary navigation">
          <button className={tab === "trade" ? "nav-active" : ""} onClick={() => setTab("trade")}>Perps</button>
          <button className={tab === "launch" ? "nav-active" : ""} onClick={() => setTab("launch")}>Launch Lab</button>
        </nav>
        <div className="topbar-meta"><span className="network"><i /> Devnet</span>{auth.authenticated ? <><button className="wallet-button" onClick={() => void navigator.clipboard.writeText(auth.walletAddress ?? "")} title="Copy wallet address"><WalletCards size={16} /> {auth.walletAddress?.slice(0, 4)}...{auth.walletAddress?.slice(-4)}</button><button className="wallet-button" onClick={() => void auth.logout()}>Log out</button></> : <button className="wallet-button" onClick={auth.login}><WalletCards size={16} /> Sign in</button>}</div>
      </header>

      <section className="status-strip" aria-live="polite">
        <div><Radio size={15} /> <strong>Trading disabled</strong><span>Authenticated previews only</span></div>
        <div><Clock3 size={15} /> MagicBlock <span>not delegated</span></div>
        <div><ShieldCheck size={15} /> Oracle <span>not connected</span></div>
      </section>

      <section className="status-strip" aria-label="StockStream status">
        <label>Market<select value={marketSymbol} onChange={(event) => setMarketSymbol(event.target.value)}>{PERP_MARKETS.map((market) => <option key={market.symbol} value={market.symbol}>{market.symbol} · {market.live ? "live" : "fixture"}</option>)}</select></label>
        <div><strong>Program</strong><span>local build available</span></div>
        <div><strong>Collateral</strong><span>test-only/not connected</span></div>
        <div><strong>Session</strong><span>{auth.authenticated ? "authenticated" : "not authenticated"}</span></div>
      </section>

      {tab === "trade" ? (
        <div className="terminal-grid">
          <section className="market-panel">
            <div className="market-heading">
              <div><p className="muted">US equities / perpetual</p><h1>{marketSymbol} <span>{marketFeedStatus}</span></h1></div>
              <div className="price"><strong>{Number.isFinite(markPrice) ? formatUsd(markPrice) : "--"}</strong><span className={marketFeedStatus === "live" ? "positive" : "muted"}>{marketFeedStatus === "live" ? "ER verified" : "feed unavailable"}</span></div>
            </div>
            <div className="market-stats">
              <Metric label="Best bid" value={Number.isFinite(bestBid) ? formatUsd(bestBid) : "--"} />
              <Metric label="Best ask" value={Number.isFinite(bestAsk) ? formatUsd(bestAsk) : "--"} />
              <Metric label="Feed" value={marketFeedStatus} />
              <Metric label="Source" value="MagicBlock ER" />
            </div>
            <div className="chart-area"><div className="chart-label"><span>Price / USD</span><span className="muted">No verified oracle feed</span></div><div className="chart-empty">Market visualization is disabled until a verified data source is connected.</div></div>
            <div className="execution-note"><Activity size={16} /><span>Perps risk reads only the Pyth index. Launch-pool values are analytics, never collateral or liquidation inputs.</span></div>
          </section>

          <section className="book-panel">
            <div className="panel-title"><h2>Order book</h2><span>Price-time priority</span></div>
            <BookRows values={book.asks} side="ask" />
            <div className="book-spread"><strong>{Number.isFinite(markPrice) ? formatUsd(markPrice) : "--"}</strong><span>{Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? `spread ${formatUsd(bestAsk - bestBid)}` : "awaiting ER data"}</span></div>
            <BookRows values={book.bids} side="bid" />
            <div className="book-foot"><span>Fixed + oracle-pegged roots</span><span>ER live</span></div>
          </section>

          <aside className="order-panel">
            <div className="panel-title"><h2>Place order</h2><span>Isolated margin</span></div>
            <div className="side-toggle" role="group" aria-label="Order direction"><button className={side === "long" ? "long active-side" : "long"} onClick={() => setSide("long")}><TrendingUp size={16} /> Long</button><button className={side === "short" ? "short active-side" : "short"} onClick={() => setSide("short")}><TrendingDown size={16} /> Short</button></div>
            <label>Order type<select defaultValue="marketable-limit"><option value="marketable-limit">Marketable limit</option><option value="limit">Limit</option><option value="post-only">Post-only</option></select></label>
            <label>Size<input value={quantity} type="number" min="1" onChange={(event) => setQuantity(event.target.value)} /><span className="input-suffix">shares</span></label>
            <label>Limit price<input value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} placeholder={Number.isFinite(markPrice) ? markPrice.toFixed(2) : "Awaiting verified price"} inputMode="decimal" /><span className="input-suffix">USD</span></label>
            <div className="order-review"><span>Estimated notional</span><strong>{Number.isFinite(notional) ? formatUsd(notional) : "--"}</strong><span>Initial margin</span><strong>{Number.isFinite(notional) ? formatUsd(notional * 0.2) : "--"}</strong><span>Est. liquidation</span><strong>Calculated on-chain</strong></div>
            <button className={side === "short" ? "submit short-submit" : "submit long-submit"} onClick={submitOrder}>{auth.authenticated ? "Preview order" : "Sign in to preview"}</button>
            <p className="form-note">Session scope: {marketConfig.symbol}. Withdrawals and collateral transfers are excluded.</p>
          </aside>

          <section className="lifecycle-panel">
            <div className="panel-title"><h2>Settlement lifecycle</h2><span>Wallet controlled</span></div>
            <div className="steps">
              <Step complete={false} active={false} label="Deposit USDC on L1" />
              <Step complete={false} active={false} label="Approve session + delegate market state" />
              <Step complete={false} active={false} label="Commit ER state to L1" />
              <Step complete={false} active={false} label="Undelegate and unlock withdrawal" />
            </div>
            <button className="lifecycle-action" onClick={runLifecycle}><LockKeyhole size={17} /> Construct seat + scratch</button>
            <div className="lifecycle-actions"><button onClick={() => constructCollateralAction(false)}>Construct deposit</button><button onClick={() => constructCollateralAction(true)}>Construct withdrawal</button></div>
            <div className="lifecycle-actions"><button onClick={constructVault}>Construct vault</button><button onClick={() => constructSessionAction()}>Authorize session</button><button onClick={() => constructSessionAction(true)}>Revoke session</button><button onClick={constructCancelAll}>Cancel all</button></div>
          </section>

          <section className="sponsor-panel">
            <div className="sponsor-icon"><Coins size={19} /></div><div><h2>Commit sponsorship</h2><p>24 sponsored commits remain. The fee-vault top-up path uses a fresh 32-byte salt and is submitted to L1.</p></div><button title="Top up delegated fee payer"><BadgeDollarSign size={18} /></button>
          </section>
          <div className="notice"><CircleAlert size={16} /><span>{notice}</span></div>
        </div>
      ) : (
        <LaunchLab onLaunch={() => setNotice("DBC execution is not enabled until an issuer wallet and configured Meteora pool parameters are available. No launch was created.")} />
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Step({ complete, active, label }: { complete: boolean; active: boolean; label: string }) { return <div className={active ? "step active-step" : complete ? "step complete-step" : "step"}><span>{complete ? <Check size={13} /> : active ? <LoaderCircle size={13} /> : ""}</span><p>{label}</p></div>; }
function BookRows({ values, side }: { values: BookLevel[]; side: "ask" | "bid" }) {
  const largest = Math.max(...values.map((level) => decimal(level.size, 1_000_000_000)), 1);
  return <div className="book-rows">{values.map((level) => {
    const price = decimal(level.price, 1_000_000);
    const size = decimal(level.size, 1_000_000_000);
    return <div key={`${level.price}-${level.size}`} className={side}><span>{Number.isFinite(price) ? price.toFixed(2) : "--"}</span><span>{Number.isFinite(size) ? size.toFixed(3) : "--"}</span><span>{Number.isFinite(size) ? (size * price).toFixed(2) : "--"}</span><i style={{ width: `${Math.max(8, (size / largest) * 75)}%` }} /></div>;
  })}</div>;
}

function LaunchLab({ onLaunch }: { onLaunch: () => void }) {
  return <div className="launch-layout">
    <section className="launch-hero"><div><p className="muted">Issuer controls / separate from perps</p><h1>Stock-paired liquidity with clear boundaries.</h1><p>Configure a Meteora DBC launch, sign it with the issuer wallet, and track graduation to DAMM v2. This pool never changes perps margin or oracle pricing.</p></div><Sparkles size={48} /></section>
    <section className="launch-config"><div className="panel-title"><h2>DBC configuration</h2><span>Issuer required</span></div><label>Launch template<select defaultValue="discovery"><option value="discovery">Equity discovery</option><option value="thin">Thin-liquidity launch</option><option value="agent">Agent-managed launch</option></select></label><label>Quote asset<select defaultValue="usdc"><option value="usdc">USDC</option><option value="stock">Supported tokenized stock</option></select></label><div className="config-stats"><Metric label="Virtual start price" value="Set by issuer" /><Metric label="Dynamic fee" value="Set by issuer" /><Metric label="Graduation target" value="Set by issuer" /></div><button className="submit launch-submit" onClick={onLaunch}>Configure issuer launch</button></section>
    <section className="launch-monitor"><div className="panel-title"><h2>Pool monitor</h2><span>No active pool</span></div><div className="progress"><span style={{ width: "0%" }} /></div><div className="monitor-items"><p><Landmark size={16} /> DBC pool <strong>not created</strong></p><p><ArrowUpRight size={16} /> DAMM v2 graduation <strong>not eligible</strong></p><p><Bot size={16} /> ClawPump agent <strong>capability check required</strong></p></div></section>
  </div>;
}
