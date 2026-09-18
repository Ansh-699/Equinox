"use client";

import Link from "next/link";
import { WalletCards } from "lucide-react";
import type { AppAuth } from "@/components/app-providers";

export type ActiveSection = "trade" | "launch" | "portfolio" | "activity" | "settings" | "diagnostics";

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
  return (
    <header className="topbar">
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
        {auth.authenticated ? (
          <>
            <button className="wallet-button" onClick={() => void navigator.clipboard.writeText(auth.walletAddress ?? "")} title="Copy wallet address">
              <WalletCards size={16} /> {auth.walletAddress?.slice(0, 4)}...{auth.walletAddress?.slice(-4)}
            </button>
            <button className="wallet-button" onClick={() => void auth.logout()}>Log out</button>
          </>
        ) : (
          <button className="wallet-button" onClick={auth.login}><WalletCards size={16} /> Sign in</button>
        )}
      </div>
    </header>
  );
}
