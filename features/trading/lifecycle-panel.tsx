import { BadgeDollarSign, Coins, LockKeyhole } from "lucide-react";
import { Step } from "./primitives";

export function LifecyclePanel({
  onSeatAndScratch,
  onDeposit,
  onWithdraw,
  onInitializeVault,
  onCancelAll,
}: {
  onSeatAndScratch: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onInitializeVault: () => void;
  onCancelAll: () => void;
}) {
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
          <button onClick={onDeposit}>Construct deposit</button>
          <button onClick={onWithdraw}>Construct withdrawal</button>
        </div>
        <div className="lifecycle-actions">
          <button onClick={onInitializeVault}>Construct vault</button>
          <button onClick={onCancelAll}>Cancel all (session)</button>
        </div>
      </section>

      <section className="sponsor-panel">
        <div className="sponsor-icon"><Coins size={19} /></div>
        <div><h2>Commit sponsorship</h2><p>24 sponsored commits remain. The fee-vault top-up path uses a fresh 32-byte salt and is submitted to L1.</p></div>
        <button title="Top up delegated fee payer"><BadgeDollarSign size={18} /></button>
      </section>
    </>
  );
}
