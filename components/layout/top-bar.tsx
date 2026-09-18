import { WalletCards } from "lucide-react";
import type { AppAuth } from "@/components/app-providers";

export function TopBar({ tab, onTabChange, auth }: { tab: "trade" | "launch"; onTabChange: (tab: "trade" | "launch") => void; auth: AppAuth }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark">S</span><span>StockStream</span></div>
      <nav aria-label="Primary navigation">
        <button className={tab === "trade" ? "nav-active" : ""} onClick={() => onTabChange("trade")}>Perps</button>
        <button className={tab === "launch" ? "nav-active" : ""} onClick={() => onTabChange("launch")}>Launch Lab</button>
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
