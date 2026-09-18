"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { WalletCards } from "lucide-react";
import type { AppAuth } from "@/components/app-providers";

export type ActiveSection = "trade" | "launch" | "portfolio" | "activity" | "settings" | "diagnostics";

type AuthDisplayBranch = "signed_in" | "choose_wallet" | "signed_out";

function branchFor(auth: AppAuth): AuthDisplayBranch {
  if (auth.walletAddress) return "signed_in";
  if (auth.wallets.length > 0) return "choose_wallet";
  return "signed_out";
}

export function TopBar({
  active,
  onTabChange,
  auth,
}: {
  active: ActiveSection;
  /** Present only on the Trade route, where "trade"/"launch" are in-page
   * tabs rather than separate routes. */
  onTabChange?: (tab: "trade" | "launch") => void;
  auth: AppAuth;
}) {
  // The topbar's Sign in / Choose wallet / wallet-address+Log out controls
  // are mutually exclusive -- activating one always unmounts it and mounts
  // a different element in its place. Left alone, a keyboard user's focus
  // silently falls back to <body> the instant that happens (found via
  // tests/browser/keyboard-only.spec.ts), stranding them with no visible
  // focus indicator anywhere on the page. Move focus to whichever one of
  // these three replaces the one they were just on.
  const primaryActionRef = useRef<HTMLElement | null>(null);
  const setPrimaryActionRef = (el: HTMLElement | null) => { primaryActionRef.current = el; };
  const branch = branchFor(auth);
  const previousBranchRef = useRef(branch);
  useEffect(() => {
    if (previousBranchRef.current !== branch) primaryActionRef.current?.focus();
    previousBranchRef.current = branch;
  }, [branch]);

  return (
    <header className="topbar">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div className="brand"><span className="brand-mark">S</span><span>StockStream</span></div>
      <nav aria-label="Primary navigation">
        {onTabChange ? (
          <>
            <button className={active === "trade" ? "nav-active" : ""} onClick={() => onTabChange("trade")}>Perps</button>
            <button className={active === "launch" ? "nav-active" : ""} onClick={() => onTabChange("launch")}>Launch Lab</button>
          </>
        ) : (
          <Link href="/">Perps</Link>
        )}
        <Link href="/portfolio" className={active === "portfolio" ? "nav-active" : ""}>Portfolio</Link>
        <Link href="/activity" className={active === "activity" ? "nav-active" : ""}>Activity</Link>
        <Link href="/settings" className={active === "settings" ? "nav-active" : ""}>Settings</Link>
        {process.env.NODE_ENV !== "production" ? (
          <Link href="/diagnostics" className={active === "diagnostics" ? "nav-active" : ""}>Diagnostics</Link>
        ) : null}
      </nav>
      <div className="topbar-meta">
        <span className="network"><i /> Devnet</span>
        {auth.walletAddress ? (
          <>
            <button ref={setPrimaryActionRef} className="wallet-button" onClick={() => void navigator.clipboard.writeText(auth.walletAddress ?? "")} title={`Copy wallet address (${auth.walletClientType ?? "unknown type"})`}>
              <WalletCards size={16} /> {auth.walletAddress?.slice(0, 4)}...{auth.walletAddress?.slice(-4)}
            </button>
            <button className="wallet-button" onClick={() => void auth.logout()}>Log out</button>
          </>
        ) : auth.wallets.length > 0 ? (
          <Link ref={setPrimaryActionRef} href="/settings" className="wallet-button">
            <WalletCards size={16} /> Choose wallet ({auth.wallets.length})
          </Link>
        ) : (
          <button ref={setPrimaryActionRef} className="wallet-button" onClick={auth.login}><WalletCards size={16} /> Sign in</button>
        )}
      </div>
    </header>
  );
}
