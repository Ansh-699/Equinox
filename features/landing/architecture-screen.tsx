"use client";

// The Architecture tab: a logo-only picture of the system. Equinox sends
// orders into the MagicBlock rollup (pre-IPO markets feed it from below),
// the rollup commits to Solana, and Solana fans out to the price and pool
// sources. Names show on hover; one dot travels each main link.

import css from "./preview.module.css";

const CANDLES: [number, number, number, number, boolean][] = [
  // x, wick top, wick bottom, body height, up
  [78, 196, 228, 16, true], [88, 188, 214, 14, true], [98, 192, 206, 7, false], [108, 184, 204, 10, true],
  [118, 188, 212, 12, false], [128, 196, 222, 12, false], [138, 190, 212, 9, true], [148, 176, 206, 16, true],
  [158, 180, 196, 7, false], [168, 166, 194, 14, true],
];

function Tile({ x, y, w, h, name }: { x: number; y: number; w: number; h: number; name: string }) {
  return (
    <rect x={x} y={y} width={w} height={h} rx={12} className={css.tile}>
      <title>{name}</title>
    </rect>
  );
}

function DocBadge({ cx, cy, tone }: { cx: number; cy: number; tone: "blue" | "violet" }) {
  return (
    <g className={css.badge2} data-tone={tone}>
      <circle cx={cx} cy={cy} r={17} />
      <path d={`M${cx - 6} ${cy - 9} h8 l4 4 v14 h-12 z`} className={css.docOutline} />
      {[-3, 0, 3, 6].map((dy) => <line key={dy} x1={cx - 3.5} x2={cx + 3.5} y1={cy + dy} y2={cy + dy} className={css.docLine} />)}
    </g>
  );
}

export function ArchitectureScreen({ rate }: { rate: number | null; blockMs?: number | null }) {
  return (
    <div className={`${css.pad} ${css.archPad}`}>
      <div className={css.screenHead}>
        <div><h3>How it works</h3><p className={css.muted}>Trades match in the MagicBlock rollup; USDC and prices live on Solana.</p></div>
        {rate !== null && <span className={`${css.chip} tnum`}><span className={css.dot} aria-hidden />{rate.toFixed(1)} tx/s</span>}
      </div>

      <svg viewBox="20 40 960 340" className={css.archArt} role="img"
        aria-label="Equinox sends orders to the MagicBlock rollup, which pre-IPO markets feed and which commits to Solana; Solana draws on Pyth, PreStocks and Meteora.">
        <defs>
          <linearGradient id="arch-blue" gradientUnits="userSpaceOnUse" x1="196" x2="346" y1="0" y2="0"><stop offset="0" stopColor="#6d8dff" /><stop offset="1" stopColor="#8aa8ff" /></linearGradient>
          <linearGradient id="arch-violet" gradientUnits="userSpaceOnUse" x1="526" x2="676" y1="0" y2="0"><stop offset="0" stopColor="#9b7bff" /><stop offset="1" stopColor="#7c6cf0" /></linearGradient>
          <linearGradient id="arch-sol" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#00ffa3" /><stop offset="1" stopColor="#dc1fff" /></linearGradient>
          <clipPath id="arch-eq"><circle cx={115} cy={130} r={26} /></clipPath>
          <clipPath id="arch-mb"><circle cx={437} cy={116} r={22} /></clipPath>
          {[385, 437, 489].map((x) => <clipPath key={x} id={`arch-pre-${x}`}><circle cx={x} cy={330} r={14} /></clipPath>)}
          {[97, 165, 233].map((y) => <clipPath key={y} id={`arch-src-${y}`}><rect x={905} y={y - 16} width={32} height={32} rx={8} /></clipPath>)}
        </defs>

        {/* Equinox: the app and its market */}
        <g className={css.node}>
          <Tile x={40} y={80} w={150} h={170} name="Equinox app" />
          <circle cx={115} cy={130} r={27} className={css.logoRing} />
          <image href="/brand/equinox-dark.png" x={89} y={104} width={52} height={52} clipPath="url(#arch-eq)" preserveAspectRatio="xMidYMid slice" />
          {CANDLES.map(([x, top, bottom, body, up]) => {
            const mid = (top + bottom) / 2;
            return (
              <g key={x} className={up ? css.candleUp : css.candleDown}>
                <line x1={x} x2={x} y1={top} y2={bottom} />
                <rect x={x - 2.5} y={mid - body / 2} width={5} height={body} rx={1} />
              </g>
            );
          })}
        </g>

        {/* orders: Equinox -> rollup */}
        <circle cx={196} cy={165} r={3.5} fill="#8aa8ff" />
        <path id="arch-link-1" d="M196 165 H346" stroke="url(#arch-blue)" className={css.link2} />
        <path d="M340 159 L348 165 L340 171" stroke="#8aa8ff" className={css.arrowHead} />
        <circle r={3} fill="#b9ccff" className={css.traveller}><animateMotion dur="2.6s" repeatCount="indefinite" path="M196 165 H346" /></circle>
        <DocBadge cx={271} cy={165} tone="blue" />

        {/* MagicBlock rollup: logo over stacked layers */}
        <g className={css.node}>
          <Tile x={355} y={80} w={165} h={170} name="MagicBlock Ephemeral Rollup" />
          {[208, 196, 184].map((y) => (
            <g key={y}>
              <path d={`M389 ${y} L437 ${y + 18} L485 ${y} L485 ${y + 7} L437 ${y + 25} L389 ${y + 7} Z`} className={css.layerSide} />
              <path d={`M389 ${y} L437 ${y - 18} L485 ${y} L437 ${y + 18} Z`} className={css.layerTop} />
            </g>
          ))}
          <circle cx={437} cy={116} r={23} className={css.logoRing} />
          <image href="/landing/magicblock.jpg" x={415} y={94} width={44} height={44} clipPath="url(#arch-mb)" preserveAspectRatio="xMidYMid slice" />
        </g>

        {/* pre-IPO markets feed the rollup */}
        <path d="M437 298 V256" className={css.dashedUp} />
        <path d="M431 263 L437 255 L443 263" className={css.arrowHeadMuted} />
        <g className={css.node}>
          <Tile x={345} y={300} w={184} h={60} name="Pre-IPO markets: OpenAI, SpaceX, Anthropic" />
          <line x1={401} x2={421} y1={330} y2={330} className={css.dashJoin} />
          <line x1={453} x2={473} y1={330} y2={330} className={css.dashJoin} />
          {([[385, "/logos/openai.png", "OpenAI"], [437, "/logos/spacex.png", "SpaceX"], [489, "/logos/anthropic.png", "Anthropic"]] as const).map(([x, src, name]) => (
            <g key={x}>
              <image href={src} x={x - 14} y={316} width={28} height={28} clipPath={`url(#arch-pre-${x})`} className={css.mono} />
              <circle cx={x} cy={330} r={14} className={css.logoRingThin}><title>{name}</title></circle>
            </g>
          ))}
        </g>

        {/* commits: rollup -> Solana */}
        <circle cx={526} cy={165} r={3.5} fill="#9b7bff" />
        <path d="M526 165 H676" stroke="url(#arch-violet)" className={css.link2} />
        <path d="M670 159 L678 165 L670 171" stroke="#8b78f5" className={css.arrowHead} />
        <circle r={3} fill="#cbbcff" className={css.traveller}><animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path="M526 165 H676" /></circle>
        <DocBadge cx={601} cy={165} tone="violet" />

        {/* Solana */}
        <g className={css.node}>
          <Tile x={685} y={112} w={118} h={106} name="Solana: Equinox program, USDC vault, oracle snapshots" />
          {[[-17, 1], [0, -1], [17, 1]].map(([dy, dir]) => {
            const cy = 165 + dy;
            // Solana's three slanted bars, alternating lean.
            return <path key={dy} d={dir > 0 ? `M722 ${cy + 6} L732 ${cy - 6} H768 L758 ${cy + 6} Z` : `M722 ${cy - 6} L732 ${cy + 6} H768 L758 ${cy - 6} Z`} fill="url(#arch-sol)" />;
          })}
        </g>

        {/* Solana draws on Pyth, PreStocks, Meteora */}
        {[97, 165, 233].map((y) => (
          <g key={y}>
            <path d={y === 165 ? "M803 165 H868" : `M803 165 C 838 165, 832 ${y}, 868 ${y}`} className={css.branch} />
            <path d={`M862 ${y - 6} L870 ${y} L862 ${y + 6}`} className={css.arrowHeadBranch} />
          </g>
        ))}
        {([[97, "/landing/pyth.png", "Pyth"], [165, "/landing/prestocks.png", "PreStocks"], [233, "/landing/meteora.svg", "Meteora"]] as const).map(([y, src, name]) => (
          <g key={y} className={css.node}>
            <Tile x={876} y={y - 30} w={90} h={60} name={name} />
            <image href={src} x={905} y={y - 16} width={32} height={32} clipPath={`url(#arch-src-${y})`} preserveAspectRatio="xMidYMid meet" />
          </g>
        ))}
      </svg>
    </div>
  );
}
