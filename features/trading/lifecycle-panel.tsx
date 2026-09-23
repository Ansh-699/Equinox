"use client";

import { Spinner } from "@/components/ui/spinner";
import { useEffect, useState } from "react";

/** Test collateral has 6 decimals. */
const COLLATERAL_DECIMALS = 6;

/** Whole-token amount -> base units, or null when not a positive amount. */
export function toCollateralUnits(amount: string): bigint | null {
  if (!/^\d+(\.\d{0,6})?$/.test(amount.trim())) return null;
  const [whole, fraction = ""] = amount.trim().split(".");
  const units = BigInt(whole) * 10n ** BigInt(COLLATERAL_DECIMALS) + BigInt(fraction.padEnd(COLLATERAL_DECIMALS, "0") || "0");
  return units > 0n ? units : null;
}

const FOCUS = "focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";
export const SECONDARY_BTN = `h-[30px] rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-2.5 text-[12px] font-medium text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)] disabled:cursor-not-allowed disabled:text-[var(--t-text-3)] disabled:border-[var(--t-border)] ${FOCUS}`;
export const HINT = "text-[10.5px] leading-snug text-[var(--t-text-3)]";
export function primaryBtn(disabled = false) {
  return `h-[34px] w-full rounded-[6px] text-[13px] font-semibold ${FOCUS} ${disabled ? "cursor-not-allowed bg-[var(--t-surface-3)] text-[var(--t-text-2)]" : "bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]"}`;
}

export function PanelHead({ title, badge, tone = "muted" }: { title: string; badge?: string; tone?: "ok" | "warn" | "muted" }) {
  const toneCls = tone === "ok" ? "bg-[rgba(34,197,94,0.12)] text-[var(--t-up)]" : tone === "warn" ? "bg-[rgba(245,158,11,0.12)] text-[var(--t-warn)]" : "bg-[var(--t-surface-3)] text-[var(--t-text-2)]";
  return (
    <div className="flex h-[36px] items-center justify-between border-b border-[var(--t-border)] px-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">{title}</h2>
      {badge ? <span className={`rounded-[4px] px-1.5 py-0.5 text-[10px] ${toneCls}`}>{badge}</span> : null}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "up" | "warn" | "down" }) {
  const color = tone === "up" ? "text-[var(--t-up)]" : tone === "warn" ? "text-[var(--t-warn)]" : tone === "down" ? "text-[var(--t-down)]" : "text-[var(--t-text)]";
  return (
    <div className="rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-[10px] py-2">
      <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">{label}</div>
      <div className={`tnum text-[14px] font-semibold ${color}`}>{value}</div>
      <div className={`${HINT} mt-0.5`}>{hint}</div>
    </div>
  );
}

function WalletIdentity({ address, privyLabel }: { address: string; privyLabel: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">Your wallet</span>
        <span className="truncate font-mono text-[12px] text-[var(--t-text)]" title={address}>{address.slice(0, 4)}…{address.slice(-4)}</span>
        <span className="truncate text-[10.5px] text-[var(--t-text-3)]" title="Login and signing are handled by Privy">via Privy · {privyLabel}</span>
      </div>

      <button type="button" onClick={() => navigator.clipboard.writeText(address).then(() => setCopied(true), () => undefined)} aria-label={copied ? "Address copied" : "Copy wallet address"} className={`shrink-0 ${SECONDARY_BTN}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const usd = (units: bigint | null) => (units === null ? "—" : `$${(Number(units) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Wallet + custody (SlipStream SessionPanel layout): identity, balances,
 * test funds, seat creation and deposit/withdraw on Solana L1. */
export function LifecyclePanel({
  walletAddress,
  privyLabel,
  onSignIn,
  walletUsdc,
  walletSol,
  seat,
  seatIndex = null,
  seatLoading = false,
  onSeatAndScratch,
  seatActionLabel = "Create V3 seat",
  onStartTrading,
  onboarding = null,
  busy = null,
  onFaucet,
  onDeposit,
  onWithdraw,
  withdrawDisabled,
  withdrawReason,
  rollupLive = false,
  onInitializeVault,
  onCancelAll,
  onCancelOrder,
  onReplaceOrder,
}: {
  walletAddress: string | null;
  /** "email · embedded wallet" style label for the Privy login behind the wallet. */
  privyLabel: string;
  onSignIn: () => void;
  walletUsdc: bigint | null;
  walletSol: bigint | null;
  seat: { availableCollateral: bigint; reservedMargin: bigint; realizedPnl: bigint } | null;
  /** The seat's index once the indexer (rollup or L1) sees it. */
  seatIndex?: number | null;
  /** The seat has not been read yet: show that instead of offering to create one. */
  seatLoading?: boolean;
  onSeatAndScratch: () => void;
  seatActionLabel?: string;
  /** One click: unlock the trading key, then faucet → seat → deposit. */
  onStartTrading?: () => void;
  /** Current onboarding step label while it runs. */
  onboarding?: string | null;
  /** Set while anything signs or confirms: every action greys out and this label shows. */
  busy?: string | null;
  onFaucet?: () => void;
  onDeposit: (units: bigint) => void;
  onWithdraw: (units: bigint) => void;
  withdrawDisabled: boolean;
  withdrawReason: string | null;
  /** Set while the market trades in the rollup: seats and deposits wait for settlement on L1. */
  rollupLive?: boolean;
  onInitializeVault: () => void;
  onCancelAll: () => void;
  onCancelOrder: (orderKey: bigint) => void;
  onReplaceOrder: (orderKey: bigint) => void;
}) {
  const [amount, setAmount] = useState("100");
  const [orderKey, setOrderKey] = useState("");
  const units = toCollateralUnits(amount);
  const parsedOrderKey = (() => { try { return orderKey ? BigInt(orderKey) : null; } catch { return null; } })();
  const lowSol = walletSol !== null && walletSol < 10_000_000n;
  const status = !walletAddress ? "signed out" : seat ? "trading" : "setup";

  return (
    <section className="lifecycle-panel" aria-label="Account">
      <PanelHead title="Wallet" badge={status} tone={status === "trading" ? "ok" : status === "setup" ? "warn" : "muted"} />
      {busy ? (
        <div role="status" className="flex items-center gap-2 border-b border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2 text-[11.5px] text-[var(--t-text)]">
          <Spinner className="h-3.5 w-3.5 text-[var(--t-up)]" /> {busy}
        </div>
      ) : null}
      <fieldset disabled={!!busy} aria-busy={!!busy} className={`m-0 min-w-0 space-y-3 border-0 p-3 transition-opacity ${busy ? "pointer-events-none opacity-60" : ""}`}>
        {!walletAddress ? (
          <div className="space-y-2.5">
            <p className="text-[11.5px] leading-relaxed text-[var(--t-text-2)]">Sign in with Privy to use an embedded Solana wallet or connect Phantom, Solflare or Backpack. Collateral stays in the program vault on Solana L1.</p>
            <button type="button" onClick={onSignIn} className={primaryBtn()}>Create wallet / sign in</button>
          </div>
        ) : (
          <>
            <WalletIdentity address={walletAddress} privyLabel={privyLabel} />
            <div className="grid grid-cols-2 gap-2">
              <Stat label="USDC" value={usd(walletUsdc)} hint="In your wallet" />
              <Stat label="SOL" value={walletSol === null ? "—" : (Number(walletSol) / 1e9).toFixed(4)} hint="For network fees" tone={lowSol ? "warn" : undefined} />
            </div>
            {onFaucet ? <button type="button" className={`w-full ${SECONDARY_BTN}`} onClick={onFaucet}>Get test USDC</button> : null}
            {lowSol ? <p className={`${HINT} text-[var(--t-warn)]`}>This wallet needs a little devnet SOL for fees — “Get test USDC” tops up SOL too.</p> : null}

            {seat ? (
              <div className="space-y-2 pt-0.5">
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-[var(--t-border)]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">In the market</span>
                  <div className="h-px flex-1 bg-[var(--t-border)]" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Available" value={usd(seat.availableCollateral)} hint="Free to trade" tone="up" />
                  <Stat label="Reserved" value={usd(seat.reservedMargin)} hint="Open orders" tone="warn" />
                  <Stat label="Realized" value={usd(seat.realizedPnl)} hint="Closed trades" tone={seat.realizedPnl < 0n ? "down" : undefined} />
                </div>
              </div>
            ) : null}
          </>
        )}

        {walletAddress && seatLoading && !seat && !onboarding ? (
          <button type="button" disabled aria-disabled className={`${primaryBtn()} cursor-default opacity-60`}>
            <span className="inline-flex items-center gap-2"><Spinner /> Checking your seat…</span>
          </button>
        ) : walletAddress && seat ? (
          <button type="button" disabled aria-disabled className={`${primaryBtn()} cursor-default opacity-60`}>
            Seat #{seatIndex ?? "—"} active
          </button>
        ) : walletAddress && onStartTrading ? (
          <button type="button" className={primaryBtn()} onClick={onStartTrading} disabled={!!onboarding}>
            {onboarding ? <span className="inline-flex items-center gap-2"><Spinner /> {onboarding}</span> : "Start trading"}
          </button>
        ) : walletAddress ? (
          <button type="button" className={primaryBtn()} onClick={onSeatAndScratch}>{seatActionLabel}</button>
        ) : null}
        <p className={HINT}>
          {rollupLive
            ? "Trading runs in the MagicBlock rollup. Your in-app trading account signs every seat, deposit, order and withdrawal — no wallet popups. Collateral settles through the vault on Solana."
            : "A seat holds your collateral and position in this market. Seats and deposits happen on Solana L1; trading happens once the market is delegated to MagicBlock."}
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="custody-amount" className="text-[12px] text-[var(--t-text-2)]">Deposit / withdraw amount</label>
          <div className="relative">
            <input id="custody-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" className={`tnum h-[34px] w-full rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-[10px] pr-14 text-[13px] text-[var(--t-text)] ${FOCUS}`} />
            <span className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 text-[11px] text-[var(--t-text-3)]">USDC</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={SECONDARY_BTN} disabled={units === null} onClick={() => units !== null && onDeposit(units)}>Deposit</button>
            <button type="button" className={SECONDARY_BTN} onClick={() => units !== null && onWithdraw(units)} disabled={withdrawDisabled || units === null} title={withdrawDisabled ? "Withdrawals disabled by market lifecycle state" : undefined}>Withdraw</button>
          </div>
          {withdrawReason ? <p className={HINT}>Withdrawals disabled: {withdrawReason}</p> : null}
        </div>

        <details className="group rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 py-2 text-[12px]">
          <summary className="cursor-pointer text-[var(--t-text-2)] hover:text-[var(--t-text)]">Advanced order tools</summary>
          <div className="mt-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={SECONDARY_BTN} onClick={onSeatAndScratch} disabled={!!seat}>{seat ? `Seat #${seatIndex ?? "—"}` : "Create seat only"}</button>
              <button type="button" className={SECONDARY_BTN} onClick={onInitializeVault}>Construct vault</button>
              <button type="button" className={SECONDARY_BTN} onClick={onCancelAll}>Cancel all (session)</button>
            </div>
            <label className="flex flex-col gap-1 text-[11.5px] text-[var(--t-text-2)]">Order key (u128, from a fill/order event)
              <input value={orderKey} onChange={(event) => setOrderKey(event.target.value)} inputMode="numeric" placeholder="0" className={`tnum h-[30px] rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-bg)] px-2 text-[12px] text-[var(--t-text)] ${FOCUS}`} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={SECONDARY_BTN} disabled={parsedOrderKey === null} onClick={() => parsedOrderKey !== null && onCancelOrder(parsedOrderKey)}>Cancel order</button>
              <button type="button" className={SECONDARY_BTN} disabled={parsedOrderKey === null} onClick={() => parsedOrderKey !== null && onReplaceOrder(parsedOrderKey)}>Replace with ticket</button>
            </div>
            <p className={HINT}>Replace uses the current ticket&apos;s side, size, price and type.</p>
          </div>
        </details>
      </fieldset>
    </section>
  );
}
