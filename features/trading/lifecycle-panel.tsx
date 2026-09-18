import { useState } from "react";
import { BadgeDollarSign, Coins, LockKeyhole } from "lucide-react";
import { Step } from "./primitives";

export function LifecyclePanel({
  onSeatAndScratch,
  onDeposit,
  onWithdraw,
  withdrawDisabled,
  onInitializeVault,
  onCancelAll,
  onCancelOrder,
  onReplaceOrder,
}: {
  onSeatAndScratch: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  withdrawDisabled: boolean;
  onInitializeVault: () => void;
  onCancelAll: () => void;
  onCancelOrder: (orderKey: bigint) => void;
  onReplaceOrder: (orderKey: bigint) => void;
}) {
  const [orderKey, setOrderKey] = useState("");
  const parsedOrderKey = (() => { try { return orderKey ? BigInt(orderKey) : null; } catch { return null; } })();

  return (
    <>
      <section className="lifecycle-panel">
        <div className="panel-title"><h2>Settlement lifecycle</h2><span>Wallet controlled</span></div>
        <div className="steps">
          <Step complete={false} active={false} label="Deposit USDC on L1" />
          <Step complete={false} active={false} label="Approve session + delegate market state" />
          <Step complete={false} active={false} label="Commit ER state to L1" />
          <Step complete={false} active={false} label="Undelegate and unlock withdrawal" />
        </div>
        <button className="lifecycle-action" onClick={onSeatAndScratch}><LockKeyhole size={17} /> Construct seat + scratch</button>
        <div className="lifecycle-actions">
          <button onClick={onDeposit}>Deposit</button>
          <button onClick={onWithdraw} disabled={withdrawDisabled} title={withdrawDisabled ? "Withdrawals disabled by market lifecycle state" : undefined}>Withdraw</button>
        </div>
        <div className="lifecycle-actions">
          <button onClick={onInitializeVault}>Construct vault</button>
          <button onClick={onCancelAll}>Cancel all (session)</button>
        </div>
        <label>Order key (u128, from a fill/order event)<input value={orderKey} onChange={(event) => setOrderKey(event.target.value)} inputMode="numeric" placeholder="0" /></label>
        <div className="lifecycle-actions">
          <button disabled={parsedOrderKey === null} onClick={() => parsedOrderKey !== null && onCancelOrder(parsedOrderKey)}>Cancel order</button>
          <button disabled={parsedOrderKey === null} onClick={() => parsedOrderKey !== null && onReplaceOrder(parsedOrderKey)}>Replace with ticket</button>
        </div>
        <p className="form-note">Replace uses the current order-ticket side/size/price/type. There is no open-orders list yet -- it needs the canonical order-book layout manifest (order keys/prices/owners live in the book arenas).</p>
      </section>

      <section className="sponsor-panel">
        <div className="sponsor-icon"><Coins size={19} /></div>
        <div><h2>Commit sponsorship</h2><p>24 sponsored commits remain. The fee-vault top-up path uses a fresh 32-byte salt and is submitted to L1.</p></div>
        <button title="Top up delegated fee payer" aria-label="Top up delegated fee payer"><BadgeDollarSign size={18} /></button>
      </section>
    </>
  );
}
