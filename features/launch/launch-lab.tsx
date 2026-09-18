import { ArrowUpRight, Bot, Landmark, Sparkles } from "lucide-react";
import { Metric } from "@/features/trading/primitives";

export function LaunchLab({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div id="main-content" tabIndex={-1} className="launch-layout">
      <section className="launch-hero">
        <div>
          <p className="muted">Issuer controls / separate from perps</p>
          <h1>Stock-paired liquidity with clear boundaries.</h1>
          <p>Configure a Meteora DBC launch, sign it with the issuer wallet, and track graduation to DAMM v2. This pool never changes perps margin or oracle pricing.</p>
        </div>
        <Sparkles size={48} />
      </section>
      <section className="launch-config">
        <div className="panel-title"><h2>DBC configuration</h2><span>Issuer required</span></div>
        <label>Launch template<select defaultValue="discovery"><option value="discovery">Equity discovery</option><option value="thin">Thin-liquidity launch</option><option value="agent">Agent-managed launch</option></select></label>
        <label>Quote asset<select defaultValue="usdc"><option value="usdc">USDC</option><option value="stock">Supported tokenized stock</option></select></label>
        <div className="config-stats">
          <Metric label="Virtual start price" value="Set by issuer" />
          <Metric label="Dynamic fee" value="Set by issuer" />
          <Metric label="Graduation target" value="Set by issuer" />
        </div>
        <button className="submit launch-submit" onClick={onLaunch}>Configure issuer launch</button>
      </section>
      <section className="launch-monitor">
        <div className="panel-title"><h2>Pool monitor</h2><span>No active pool</span></div>
        <div className="progress"><span style={{ width: "0%" }} /></div>
        <div className="monitor-items">
          <p><Landmark size={16} /> DBC pool <strong>not created</strong></p>
          <p><ArrowUpRight size={16} /> DAMM v2 graduation <strong>not eligible</strong></p>
          <p><Bot size={16} /> ClawPump agent <strong>capability check required</strong></p>
        </div>
      </section>
    </div>
  );
}
