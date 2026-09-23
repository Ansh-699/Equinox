"use client";
/* eslint-disable @next/next/no-img-element -- wallet icons are data URIs from the extensions */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Droplets, LogOut, X } from "lucide-react";
import type { AppAuth } from "@/components/app-providers";
import { WalletSelector } from "@/features/wallet/wallet-selector";
import { refreshWalletBalances, useWalletBalances } from "@/features/portfolio/use-wallet-balances";
import { loadTradingKey } from "@/lib/trading-key";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { deriveV3ExecutionAccounts } from "@/clients/stockstream/src";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { claimTestFunds } from "@/lib/faucet-client";
import { SolanaRpcTransport } from "@/lib/rpc-transport";
import deployment from "@/config/stockstream-deployment.json";
import { decodeV3SeatShard } from "../../workers/src/v3-market-state";

const L1_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// Privy's own modal only for methods it can serve (email/Google); browser
// wallets connect directly in this drawer.
const PRIVY_MODAL_LOGIN = /email|google/.test(process.env.NEXT_PUBLIC_PRIVY_LOGIN_METHODS ?? "email,wallet");
const usd = (units: bigint | null) => (units === null ? "—" : `$${(Number(units) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

interface Seat { index: number; available: bigint; reserved: bigint; position: bigint }

/** The wallet's seat in the live market, read from whichever chain holds it. */
function useSeat(wallet: string | null, delegated: boolean, open: boolean): Seat | null | undefined {
  const [seat, setSeat] = useState<Seat | null | undefined>(undefined);
  useEffect(() => {
    if (!wallet || !open || !deployment.core) return;
    let stopped = false;
    const shards = deriveV3ExecutionAccounts(deployment.core, deployment.core).seatShards.map(String);
    const load = async () => {
      const response = await fetch(delegated ? deployment.magicBlock.rpc : L1_RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [shards, { encoding: "base64", commitment: "confirmed" }] }),
      }).then((r) => r.json()).catch(() => null) as { result?: { value: ({ data: [string] } | null)[] } } | null;
      if (stopped || !response?.result) return;
      const positions = response.result.value.flatMap((account) => (account ? decodeV3SeatShard(Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0)))?.positions ?? [] : []));
      const own = positions.find((p) => p.trader === wallet);
      setSeat(own ? { index: own.shard * 32 + own.slot, available: own.availableCollateral, reserved: own.reservedMargin, position: own.basePosition } : null);
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [wallet, delegated, open]);
  return wallet ? seat : undefined;
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "up" | "warn" }) {
  return (
    <div className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2.5">
      <div className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">{label}</div>
      <div className={`tnum mt-0.5 text-[16px] font-semibold ${tone === "up" ? "text-[var(--t-up)]" : tone === "warn" ? "text-[var(--t-warn)]" : "text-[var(--t-text)]"}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10.5px] text-[var(--t-text-3)]">{hint}</div> : null}
    </div>
  );
}

/** Slide-over wallet panel: connect (installed Solana wallets, one signature
 * via Privy SIWS), then the account: balances, vault seat and market state. */
export function WalletDrawer({ auth, open, onClose }: { auth: AppAuth; open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rpc = useMemo(() => new SolanaRpcTransport(L1_RPC), []);
  const address = auth.walletAddress;
  const ata = useMemo(() => (address && deployment.collateralMint ? String(deriveCollateralTokenAccount(address, deployment.collateralMint, TOKEN_PROGRAM)) : null), [address]);
  const balances = useWalletBalances(open ? rpc : null, address, ata);
  const execution = useExecutionStatus(open ? publicMarketApiUrl : undefined, "TSLA-PERP");
  const delegated = execution?.marketDelegated ?? false;
  // The in-app trading key (lib/trading-key.ts) holds the seat once unlocked on the Trade page.
  const trading = useMemo(() => (address && open ? loadTradingKey(address)?.publicKey.toBase58() ?? null : null), [address, open]);
  const tradingAta = useMemo(() => (trading && deployment.collateralMint ? String(deriveCollateralTokenAccount(trading, deployment.collateralMint, TOKEN_PROGRAM)) : null), [trading]);
  const tradingBalances = useWalletBalances(open && trading ? rpc : null, trading, tradingAta);
  const seat = useSeat(trading ?? address, delegated, open);
  const privyNote = auth.authError?.startsWith("Privy sign-in skipped") ? "Wallet connected · Privy linking unavailable" : null;
  const icon = auth.walletOptions.find((option) => option.name.toLowerCase() === auth.walletClientType)?.icon;

  // Focus into the panel on open; Escape closes.
  useEffect(() => {
    if (!open) return;
    (panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panelRef.current?.querySelector<HTMLElement>("button, a"))?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, address]);

  async function connect(name: string) {
    setConnecting(name);
    setError(null);
    try { await auth.connectWith(name); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setConnecting(null); }
  }

  async function claimFunds() {
    if (!address) return;
    setNotice("Sending test funds…");
    setNotice(await claimTestFunds(auth, address));
    refreshWalletBalances();
  }

  return (
    <div aria-hidden={!open} className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}>
      <div onClick={onClose} className={`absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={address ? "Account" : "Connect wallet"}
        className={`absolute right-0 top-0 flex h-full w-full max-w-[400px] flex-col border-l border-[var(--t-border)] bg-[var(--t-bg)] shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {open ? (
          <>
            <div className="flex items-center justify-between px-5 pb-3 pt-5">
              {address ? (
                <div className="flex min-w-0 items-center gap-3">
                  {icon ? <img src={icon} alt="" className="h-9 w-9 rounded-[10px]" /> : <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--t-up-3)] text-[13px] font-bold text-white">{address.slice(0, 1)}</span>}
                  <div className="min-w-0">
                    <button type="button" onClick={() => void navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} className="flex items-center gap-1.5 font-mono text-[14px] font-semibold text-[var(--t-text)]" aria-label="Copy wallet address">
                      {short(address)} {copied ? <Check className="h-3.5 w-3.5 text-[var(--t-up)]" /> : <Copy className="h-3.5 w-3.5 text-[var(--t-text-3)]" />}
                    </button>
                    <div className="truncate text-[11.5px] text-[var(--t-text-3)]">{auth.privyAuthenticated ? `via Privy · ${auth.userLabel ?? auth.walletClientType ?? "wallet"}` : privyNote ?? `${auth.walletClientType ?? "wallet"} · connected`}</div>
                  </div>
                </div>
              ) : (
                <h2 className="text-[18px] font-semibold text-[var(--t-text)]">Connect Wallet</h2>
              )}
              <div className="flex items-center gap-1">
                {address || auth.wallets.length ? (
                  <button type="button" onClick={() => { void auth.logout(); onClose(); }} aria-label="Disconnect" title="Disconnect" className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--t-text-3)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-down)]">
                    <LogOut className="h-4 w-4" />
                  </button>
                ) : null}
                <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--t-text-3)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="slim-scroll flex-1 overflow-y-auto px-5 pb-6">
              {!address ? (
                <>
                  {auth.wallets.length > 1 ? (
                    <section className="mb-5">
                      <h3 className="mb-2 text-[12px] text-[var(--t-text-3)]">Choose the wallet to trade with</h3>
                      <WalletSelector />
                    </section>
                  ) : null}
                  {auth.walletOptions.length ? (
                    <>
                      <h3 className="mb-2 text-[12px] text-[var(--t-text-3)]">Installed wallets</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {auth.walletOptions.map((option, index) => (
                          <button key={option.name} type="button" data-autofocus={index === 0 ? "" : undefined} disabled={!!connecting} onClick={() => void connect(option.name)}
                            className="flex h-[58px] items-center gap-3 rounded-[10px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 text-left text-[14px] text-[var(--t-text)] transition-colors hover:border-[var(--t-border-strong)] hover:bg-[var(--t-surface-3)] disabled:opacity-60">
                            <img src={option.icon} alt="" className="h-8 w-8 rounded-[8px]" />
                            <span className="truncate">{connecting === option.name ? "Connecting…" : option.name}</span>
                          </button>
                        ))}
                      </div>
                      <p className="mt-3 text-[11.5px] leading-snug text-[var(--t-text-3)]">Connecting asks your wallet to approve this site, then sign one message to link it to Privy. No transaction, no fee.</p>
                    </>
                  ) : (
                    <p className="text-[12.5px] leading-relaxed text-[var(--t-text-2)]">No Solana wallet extension found. Install <a className="text-[var(--t-link)] underline" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">Phantom</a> or <a className="text-[var(--t-link)] underline" href="https://solflare.com/download" target="_blank" rel="noopener noreferrer">Solflare</a>, or sign in with Privy.</p>
                  )}
                  {error ? <p role="alert" className="mt-3 break-words text-[12px] text-[var(--t-down)]">{error}</p> : null}
                  {PRIVY_MODAL_LOGIN ? <div className="mt-5 border-t border-[var(--t-border)] pt-4">
                    <button type="button" onClick={() => { auth.login(); onClose(); }} className="h-[38px] w-full rounded-[8px] border border-[var(--t-border-strong)] text-[13px] font-medium text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">
                      Sign in
                    </button>
                    <p className="mt-2 text-[11px] text-[var(--t-text-3)]">Email and other Privy login methods</p>
                  </div> : (
                    <p className="mt-5 border-t border-[var(--t-border)] pt-4 text-[11px] text-[var(--t-text-3)]">New to Solana wallets? <a className="text-[var(--t-link)]" href="https://phantom.com/learn" target="_blank" rel="noopener noreferrer">Learn more ↗</a></p>
                  )}
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="SOL" value={balances.solLamports === null ? "—" : (Number(balances.solLamports) / 1e9).toFixed(4)} hint="Network fees" tone={balances.solLamports !== null && balances.solLamports < 10_000_000n ? "warn" : undefined} />
                    <Stat label="USDC" value={usd(balances.collateralTokenBalance)} hint="In your wallet" />
                  </div>

                  {trading ? (
                    <>
                      <h3 className="mb-2 mt-5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">Trading account · {trading.slice(0, 4)}…{trading.slice(-4)}</h3>
                      <div className="grid grid-cols-2 gap-2">
                        <Stat label="USDC" value={usd(tradingBalances.collateralTokenBalance)} hint="Signs trades silently" />
                        <Stat label="SOL" value={tradingBalances.solLamports === null ? "—" : (Number(tradingBalances.solLamports) / 1e9).toFixed(4)} hint="Fees" />
                      </div>
                    </>
                  ) : null}
                  <h3 className="mb-2 mt-5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">Vault · TSLA-PERP</h3>
                  {seat === undefined ? (
                    <p className="text-[12px] text-[var(--t-text-3)]">Reading your seat…</p>
                  ) : seat === null ? (
                    <p className="text-[12.5px] leading-relaxed text-[var(--t-text-2)]">No seat yet. Press “Start trading” on the Trade page: it funds your trading account, creates the seat and deposits in one go.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <Stat label="Available" value={usd(seat.available)} hint="Free collateral" tone="up" />
                      <Stat label="Reserved" value={usd(seat.reserved)} hint="Open orders" />
                      <Stat label="Position" value={`${seat.position > 0n ? "+" : ""}${seat.position} TSLA`} hint={`Seat #${seat.index}`} />
                      <Stat label="Custody" value="Solana L1" hint="Program vault" />
                    </div>
                  )}

                  <div className="mt-5 flex items-center gap-2 rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2.5 text-[12px]">
                    <span className={`h-2 w-2 rounded-full ${delegated ? "bg-[var(--t-up)]" : "bg-[var(--t-warn)]"}`} />
                    <span className="text-[var(--t-text-2)]">{execution === null ? "Checking market…" : delegated ? "Orders route to the MagicBlock rollup — no popups per fill." : "Market on Solana L1: seats, deposits and withdrawals open."}</span>
                  </div>

                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => void claimFunds()} className="flex h-[38px] items-center justify-center gap-2 rounded-[8px] border border-[var(--t-border-strong)] text-[13px] text-[var(--t-text)] transition-colors hover:bg-[var(--t-surface-3)]"><Droplets className="h-4 w-4" /> Test USDC</button>
                    <Link href="/trade" onClick={onClose} className="flex h-[38px] items-center justify-center rounded-[8px] bg-[var(--t-up-3)] text-[13px] font-semibold text-[var(--t-on-fill)] transition-colors hover:bg-[var(--t-up-2)]">Trade</Link>
                  </div>
                  {notice ? <p role="status" className="mt-2 text-[12px] text-[var(--t-text-2)]">{notice}</p> : null}
                  {auth.wallets.length > 1 ? (
                    <section className="mt-5">
                      <h3 className="mb-2 text-[12px] text-[var(--t-text-3)]">Wallets</h3>
                      <WalletSelector />
                    </section>
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
