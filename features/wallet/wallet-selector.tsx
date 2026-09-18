"use client";

import { useWalletSelection } from "@/components/app-providers";

function shorten(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Explicit active-wallet selection (spec section 6/settings item 2).
 * Never signs with an unselected wallet: selectWallet() is the only way
 * `selectedAddress` (and therefore the trading signer) changes, and it
 * refuses any address not currently in the discovered wallet list. */
export function WalletSelector() {
  const selection = useWalletSelection();

  if (selection.wallets.length === 0) {
    return <p className="form-note">No wallets discovered yet.</p>;
  }

  if (selection.wallets.length === 1) {
    const wallet = selection.wallets[0];
    return (
      <div className="wallet-selector">
        <p className="form-note">Only one wallet is connected -- it is used automatically.</p>
        <div className="wallet-option wallet-option-active">
          <span>{shorten(wallet.address)}</span>
          <span className="muted">{wallet.walletClientType}</span>
          <span className="positive">active</span>
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-selector" role="radiogroup" aria-label="Active wallet">
      {selection.wallets.map((wallet) => {
        const active = wallet.address === selection.selectedAddress;
        return (
          <button
            key={wallet.address}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? "wallet-option wallet-option-active" : "wallet-option"}
            onClick={() => selection.selectWallet(wallet.address)}
          >
            <span>{shorten(wallet.address)}</span>
            <span className="muted">{wallet.walletClientType}</span>
            <span className={active ? "positive" : "muted"}>{active ? "active" : "select"}</span>
          </button>
        );
      })}
      {!selection.selectedAddress ? (
        <p className="form-note negative">Multiple wallets are connected -- choose one before trading. Nothing signs until you do.</p>
      ) : null}
    </div>
  );
}
