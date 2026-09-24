/* eslint-disable @next/next/no-img-element -- small static logos from /public */
import { marketBase, marketLogo } from "@/lib/v3-markets";

/** A market's logo in a round chip, or its first letter when it has none. */
export function MarketIcon({ symbol, size = 24 }: { symbol: string; size?: number }) {
  const logo = marketLogo(symbol);
  return (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-[var(--t-border)]" style={{ width: size, height: size }}>
      {logo
        ? <img src={logo} alt="" width={size} height={size} className={logo.endsWith(".svg") ? "h-[62%] w-[62%] object-contain" : "h-full w-full object-cover"} />
        : <span className="text-[10px] font-bold text-neutral-800">{marketBase(symbol).slice(0, 1)}</span>}
    </span>
  );
}
