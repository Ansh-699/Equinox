"use client";

import { useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { WalletSelector } from "@/features/wallet/wallet-selector";
import { useEquinoxProtocol } from "@/features/wallet/use-equinox-protocol";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { marketForSymbol } from "@/lib/markets";

const marketApiUrl = process.env.NEXT_PUBLIC_EQUINOX_MARKET_API_URL;
const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_EQUINOX_RELAYER_ADDRESS;

export function SettingsView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_EQUINOX_MARKET_SYMBOL ?? "AAPL-PERP";
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_EQUINOX_MARKET_ADDRESS ?? marketConfig.marketPda;
  const protocol = useEquinoxProtocol(auth.authenticated ? marketAddress : null);
  const session = useTradingSession(protocol, auth.walletAddress, marketAddress, 0);
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <main className="shell">
      <TopBar active="settings" auth={auth} />
      <div id="main-content" tabIndex={-1} className="settings-grid">
        <section className="session-panel">
          <div className="panel-title"><h2>Active wallet</h2><span>{auth.authenticated ? "connected" : auth.walletAddress ? "wallet selected" : "not connected"}</span></div>
          {auth.walletAddress ? (
            <dl className="session-detail">
              <dt>Address</dt><dd>{auth.walletAddress}</dd>
              <dt>Wallet type</dt><dd>{auth.walletClientType ?? "unknown"}</dd>
              <dt>Discovered wallets</dt><dd>{auth.wallets.length}</dd>
            </dl>
          ) : (
            <p className="form-note">
              {auth.wallets.length > 0
                ? auth.privyAuthenticated
                  ? "Choose a wallet below before trading."
                  : "A wallet is connected but the Privy sign-in did not finish. Finish sign-in, or disconnect and try again. (If this keeps happening, enable Solana wallet login in the Privy dashboard.)"
                : "Sign in with Privy to see wallet details."}
            </p>
          )}
          <dl className="session-detail" style={{ marginTop: 10 }}>
            <dt>Privy account</dt><dd>{auth.privyAuthenticated ? auth.userLabel ?? "wallet login" : "not signed in"}</dd>
          </dl>
          <WalletSelector />
          {auth.wallets.length > 0 || auth.privyAuthenticated ? (
            <div style={{ display: "flex", gap: 8 }}>
              {!auth.walletAddress && auth.wallets.length === 1 ? <button onClick={auth.login}>Finish sign-in</button> : null}
              <button onClick={() => void auth.logout()}>Disconnect wallet</button>
            </div>
          ) : null}
        </section>

        <section className="session-panel">
          <div className="panel-title"><h2>Trading session</h2><span>{session.status ? (session.status.revoked ? "revoked" : "authorized") : "none"}</span></div>
          {session.status ? (
            <>
              <dl className="session-detail">
                <dt>Session public key</dt><dd>{session.status.sessionSignerAddress}</dd>
                <dt>Session PDA</dt><dd>{session.status.sessionPda}</dd>
                <dt>Market</dt><dd>{marketSymbol}</dd>
                <dt>Expires</dt><dd>{new Date(session.status.expiresAt * 1000).toLocaleString()} <span className="muted">(market clock)</span></dd>
                <dt>Max order notional</dt><dd>{session.status.maxOrderNotional}</dd>
                <dt>Max cumulative notional</dt><dd>{session.status.maxCumulativeNotional}</dd>
                <dt>Max exposure</dt><dd>{session.status.maximumExposure}</dd>
                <dt>Max open orders</dt><dd>{session.status.maximumOpenOrders}</dd>
                <dt>Next nonce</dt><dd>{session.status.nextExpectedNonce.toString()}</dd>
              </dl>
              <div className="lifecycle-actions">
                <button disabled={session.pending} onClick={() => void session.revoke()}>{session.pending ? "Revoking…" : "Revoke session"}</button>
                <button onClick={() => { session.clearLocal(); setNotice("Local session key cleared. The on-chain session (if any) is untouched -- revoke it separately if you want it invalidated."); }}>Clear local session</button>
              </div>
            </>
          ) : (
            <p className="form-note">No authorized session for this wallet/market. Authorize one from the Trade page.</p>
          )}
          {session.error ? <p className="form-note negative">{session.error}</p> : null}
          {notice ? <p className="form-note">{notice}</p> : null}
        </section>

        <section className="session-panel">
          <div className="panel-title"><h2>Network and relayer</h2><span>Devnet</span></div>
          <dl className="session-detail">
            <dt>Solana RPC</dt><dd>{process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "default public devnet endpoint"}</dd>
            <dt>Market API</dt><dd>{marketApiUrl ?? "not configured"}</dd>
            <dt>Relayer fee payer</dt><dd>{RELAYER_ADDRESS ?? "not configured (session trading blocked)"}</dd>
            <dt>MagicBlock status</dt><dd>{executionStatus ? executionStatus.marketDelegated ? "ER active" : "not delegated" : "unavailable"}</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}
