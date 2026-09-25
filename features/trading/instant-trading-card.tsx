"use client";

import { Spinner } from "@/components/ui/spinner";
import { PanelHead, primaryBtn } from "./lifecycle-panel";

const usd = (units: bigint) => `$${(Number(units) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The in-app trading key (lib/trading-key.ts): one wallet signature, then
 * every rollup action signs silently. Also surfaces collateral still sitting
 * in a seat owned by the main wallet itself, so it can be taken back out. */
export function InstantTradingCard({ tradingAddress, unlocking, onEnable, walletSeat, walletSeatBusy, onWithdrawWalletSeat, disabled }: {
  tradingAddress: string | null;
  unlocking: boolean;
  onEnable: () => void;
  walletSeat: { index: number; available: bigint } | null;
  walletSeatBusy: boolean;
  onWithdrawWalletSeat: () => void;
  disabled: boolean;
}) {
  const on = tradingAddress !== null;
  const leftover = walletSeat && walletSeat.available > 0n;
  return (
    <section aria-label="Instant trading">
      <PanelHead title="Instant trading" badge={on ? "on" : "off"} tone={on ? "ok" : "muted"} />
      {on && !leftover ? null : <div className="space-y-2.5 p-3">
        {on ? null : (
          <>
            <p className="text-[11.5px] leading-relaxed text-[var(--t-text-2)]">One wallet signature unlocks your in-app trading account. After that every rollup action signs silently — no popups, orders confirm at rollup speed.</p>
            <button type="button" className={primaryBtn()} onClick={onEnable} disabled={unlocking || disabled}>
              {unlocking ? <span className="inline-flex items-center gap-2"><Spinner /> Waiting for wallet signature…</span> : "Enable instant trading"}
            </button>
          </>
        )}
        {leftover ? (
          <div className="rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] p-2.5 text-[11.5px] text-[var(--t-text-2)]">
            <p>Your wallet&apos;s own margin account #{walletSeat.index} still holds <span className="tnum text-[var(--t-text)]">{usd(walletSeat.available)}</span>.</p>
            <button type="button" onClick={onWithdrawWalletSeat} disabled={walletSeatBusy || disabled}
              className="mt-2 inline-flex h-[30px] w-full items-center justify-center gap-2 rounded-[4px] border border-[var(--t-border-strong)] text-[12px] text-[var(--t-text)] transition-colors hover:bg-[var(--t-surface-3)] disabled:cursor-not-allowed disabled:opacity-50">
              {walletSeatBusy ? <><Spinner /> Withdrawing…</> : "Withdraw it to your wallet (2 wallet signatures)"}
            </button>
          </div>
        ) : null}
      </div>}
    </section>
  );
}
