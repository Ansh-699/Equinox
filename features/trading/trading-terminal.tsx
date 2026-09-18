"use client";

import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { TradingDisabledBanner, ProtocolStatusStrip } from "@/components/layout/status-strip";
import { useAppAuth } from "@/components/app-providers";
import {
  createSession,
  lookupSession,
} from "@/lib/session-trading";
import { cancelAll, createTraderSeat, depositCollateral, initializeSettlementScratch, initializeVault, previewPlaceOrder, withdrawCollateral } from "@/clients/stockstream/src";
import { marketForSymbol } from "@/lib/markets";
import { RpcFailure } from "@/lib/rpc-transport";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { useStockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
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
  const [notice, setNotice] = useState("Live submission requires verified Pyth pricing, USDC custody and MagicBlock delegation.");
  const [marketSymbol, setMarketSymbol] = useState(process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? "AAPL-PERP");
  const [book, setBook] = useState<{ bids: BookLevel[]; asks: BookLevel[] }>({ bids: [], asks: [] });
  const [marketFeedStatus, setMarketFeedStatus] = useState<"connecting" | "live" | "unavailable">(marketApiUrl ? "connecting" : "unavailable");
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS ?? marketConfig.marketPda;
  const protocol = useStockStreamProtocol(auth.authenticated ? marketAddress : null);
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

  function resolveCustodyAccounts() {
    if (!auth.walletAddress || !marketAddress) return null;
    const mint = process.env.NEXT_PUBLIC_STOCKSTREAM_COLLATERAL_MINT;
    const tokenProgram = process.env.NEXT_PUBLIC_STOCKSTREAM_TOKEN_PROGRAM;
    const vault = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT ?? marketConfig.vaultPda;
    const vaultAuthority = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT_AUTHORITY;
    if (!mint || !tokenProgram || !vault || !vaultAuthority) return null;
    return { market: marketAddress, authority: auth.walletAddress, seat: auth.walletAddress, seatIndex: 0, sourceOrDestination: auth.walletAddress, mint, tokenProgram, vault, vaultAuthority };
  }

  function constructWithdrawPreview() {
    const accounts = resolveCustodyAccounts();
    if (!accounts) { setNotice("Configure the market, collateral mint/vault addresses and sign in before constructing a withdrawal."); return; }
    const ix = withdrawCollateral(accounts, BigInt(quantityNumber || 1));
    setNotice(`Constructed WithdrawCollateral with ${ix.keys.length} accounts. Runtime submission is disabled until margin-health and buffer checks are implemented.`);
  }

  async function submitDeposit() {
    const accounts = resolveCustodyAccounts();
    if (!accounts) { setNotice("Configure the market, collateral mint/vault addresses and sign in before depositing."); return; }
    if (!protocol) { setNotice("Deposit blocked: connect a wallet capable of signing on Devnet."); return; }
    const amount = BigInt(quantityNumber || 1);
    const instruction = depositCollateral(accounts, amount);
    const preview: TransactionPreview = {
      instruction: "DepositCollateral",
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
      status: "constructed",
    };
    setNotice(`Simulating DepositCollateral for ${amount} base units…`);
    try {
      const result = await protocol.service.executeL1(preview, [instruction]);
      const vaultBalance = await protocol.rpc.tokenBalance(accounts.vault).catch(() => null);
      setNotice(`DepositCollateral ${result.confirmation} — signature ${result.signature.slice(0, 8)}…${result.signature.slice(-8)}.${vaultBalance !== null ? ` Vault balance (readback): ${vaultBalance} base units.` : ""}`);
    } catch (error) {
      setNotice(error instanceof RpcFailure ? `DepositCollateral failed at ${error.method} (${error.code}).` : error instanceof Error ? error.message : "Deposit failed");
    }
  }

  function constructSessionAction(revoke = false) {
    void revoke;
    if (!auth.walletAddress || !marketAddress) { setNotice("Configure the market address and sign in before constructing session actions."); return; }
    // Session keys are generated and held in the browser only
    // (lib/browser-session.ts). One main-wallet signature authorizes
    // trading; trades are then signed by the session key alone.
    void createSession(auth.walletAddress, marketAddress, 0).then((created) => {
      const info = lookupSession(auth.walletAddress!, marketAddress, 0);
      const signerAddress = created.sessionSignerAddress;
      setNotice(created.reused
        ? `Reused browser session key (${(info?.sessionSignerAddress ?? created.sessionSignerAddress).slice(0, 6)}…) for PDA ${created.sessionPda}. One main-wallet approval will authorize it on-chain.`
        : `New browser session key created (memory only, key ${(info?.sessionSignerAddress ?? created.sessionSignerAddress).slice(0, 6)}…). PDA ${created.sessionPda}. One main-wallet approval will authorize it.`);
    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Session key creation failed"));
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
      <TopBar tab={tab} onTabChange={setTab} auth={auth} />
      <TradingDisabledBanner />
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
            markPrice={markPrice}
            notional={notional}
            authenticated={auth.authenticated}
            marketConfig={marketConfig}
            onSubmit={submitOrder}
          />
          <LifecyclePanel
            onSeatAndScratch={runLifecycle}
            onDeposit={() => void submitDeposit()}
            onWithdraw={constructWithdrawPreview}
            onInitializeVault={constructVault}
            onAuthorizeSession={() => constructSessionAction()}
            onRevokeSession={() => constructSessionAction(true)}
            onCancelAll={constructCancelAll}
          />
          <div className="notice"><CircleAlert size={16} /><span>{notice}</span></div>
        </div>
      ) : (
        <LaunchLab onLaunch={() => setNotice("DBC execution is not enabled until an issuer wallet and configured Meteora pool parameters are available. No launch was created.")} />
      )}
    </main>
  );
}
