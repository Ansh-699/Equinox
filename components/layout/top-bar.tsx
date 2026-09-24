"use client";
/* eslint-disable @next/next/no-img-element -- wallet icons are extension data URIs */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Compass, WalletCards, Zap } from "lucide-react";
import { WalletDrawer } from "@/components/wallet/wallet-drawer";
import type { AppAuth } from "@/components/app-providers";
import { ThemeToggle } from "@/components/theme-toggle";
import { DEMO_PROGRAM_ID } from "@/lib/demo-config";

const OPEN_WALLET_EVENT = "equinox:open-wallet";
/** Opens the wallet drawer from anywhere (e.g. "Sign in to trade"). */
export function openWalletDrawer() {
  window.dispatchEvent(new Event(OPEN_WALLET_EVENT));
}

export type ActiveSection = "trade" | "launch" | "pre-ipo" | "portfolio" | "activity" | "settings" | "diagnostics";

type AuthDisplayBranch = "signed_in" | "choose_wallet" | "signed_out";

function branchFor(auth: AppAuth): AuthDisplayBranch {
  if (auth.walletAddress) return "signed_in";
  if (auth.wallets.length > 0) return "choose_wallet";
  return "signed_out";
}

const NAV = [
  { id: "trade", href: "/trade", label: "Trade" },
  { id: "launch", href: "/launch", label: "Launch" },
  { id: "pre-ipo", href: "/pre-ipo", label: "Pre-IPO" },
  { id: "portfolio", href: "/portfolio", label: "Portfolio" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "settings", href: "/settings", label: "Settings" },
  { id: "diagnostics", href: "/diagnostics", label: "Diagnostics" },
] as const satisfies readonly { id: ActiveSection; href: string; label: string }[];

const ICON_LINK = "hidden h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] sm:inline-flex";

/** Terminal top bar (SlipStream TerminalNav): identity and sections on the
 * left; utilities, theme and wallet on the right. */
export function TopBar({ active, auth }: { active: ActiveSection; auth: AppAuth }) {
  // Sign in / Choose wallet / address+Log out are mutually exclusive: activating
  // one unmounts it. Move focus to whichever replaces it so keyboard users are
  // never stranded on <body> (tests/browser/keyboard-only.spec.ts).
  const primaryActionRef = useRef<HTMLElement | null>(null);
  const setPrimaryActionRef = (el: HTMLElement | null) => { primaryActionRef.current = el; };
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = useCallback(() => { setDrawer(false); primaryActionRef.current?.focus(); }, []);
  useEffect(() => {
    const open = () => setDrawer(true);
    window.addEventListener(OPEN_WALLET_EVENT, open);
    return () => window.removeEventListener(OPEN_WALLET_EVENT, open);
  }, []);
  const walletIcon = auth.walletOptions.find((option) => option.name.toLowerCase() === auth.walletClientType)?.icon;
  const branch = branchFor(auth);
  const previousBranchRef = useRef(branch);
  useEffect(() => {
    if (previousBranchRef.current !== branch) primaryActionRef.current?.focus();
    previousBranchRef.current = branch;
  }, [branch]);

  return (
    <header className="relative flex h-[60px] shrink-0 items-center border-b border-[var(--t-border)] bg-[var(--t-bg)] px-4 sm:h-[68px] sm:px-6">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Equinox home">
        <img src="/favicon.svg" alt="" className="h-7 w-7 rounded sm:h-8 sm:w-8" />
        <span className="text-[19px] font-semibold tracking-[-0.035em] text-[var(--t-text)] sm:text-[25px]">Equinox</span>
      </Link>
      <span className="ml-3 hidden rounded bg-[var(--t-surface-3)] px-2 py-0.5 text-[10px] font-medium text-[var(--t-text-2)] xl:inline">Devnet</span>

      <nav aria-label="Primary navigation" className="slim-scroll ml-6 hidden h-full min-w-0 flex-1 items-stretch gap-5 overflow-x-auto md:flex">
        {NAV.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active === item.id ? "page" : undefined}
            className={`relative flex items-center text-[14px] font-medium transition-colors ${
              active === item.id
                ? "text-[var(--t-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-[var(--t-text)]"
                : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <a href={`https://explorer.solana.com/address/${DEMO_PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className={ICON_LINK} aria-label="Program on Solana Explorer" title="Program on Explorer">
          <Compass className="h-4 w-4" strokeWidth={1.75} />
        </a>
        <a href="https://www.magicblock.gg/" target="_blank" rel="noopener noreferrer" className={ICON_LINK} aria-label="MagicBlock" title="MagicBlock">
          <Zap className="h-4 w-4" strokeWidth={1.75} />
        </a>
        <ThemeToggle />
        <div className="ml-2 flex items-center gap-2">
          {auth.walletAddress ? (
            <button ref={setPrimaryActionRef} className="wallet-button wallet-chip topbar-wallet" onClick={() => setDrawer(true)} aria-label={`Account ${auth.walletAddress.slice(0, 4)}...${auth.walletAddress.slice(-4)}`}>
              {walletIcon ? <img src={walletIcon} alt="" className="h-[18px] w-[18px] rounded-[5px]" /> : <WalletCards size={15} />}
              <span className="font-mono">{auth.walletAddress.slice(0, 4)}...{auth.walletAddress.slice(-4)}</span>
              <ChevronDown size={14} className="opacity-60" />
            </button>
          ) : (
            <button ref={setPrimaryActionRef} className="wallet-button topbar-wallet" onClick={() => setDrawer(true)}>
              <WalletCards size={15} />
              {auth.wallets.length > 1 ? `Choose wallet (${auth.wallets.length})` : auth.wallets.length === 1 ? "Finish sign-in" : "Connect wallet"}
            </button>
          )}
        </div>
      </div>
    <WalletDrawer auth={auth} open={drawer} onClose={closeDrawer} />
    </header>
  );
}
