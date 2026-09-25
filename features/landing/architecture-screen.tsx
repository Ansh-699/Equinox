"use client";
/* eslint-disable @next/next/no-img-element -- static logos */

// The Architecture tab: how Equinox fits together (docs/architecture.md), as a
// diagram of the real components. Links animate in the direction data moves;
// hovering a node highlights what it talks to. Phones get a stacked list.

import { useState } from "react";
import css from "./preview.module.css";

type NodeId = "app" | "er" | "l1" | "mm" | "prestocks" | "pyth" | "meteora";

interface ArchNode { id: NodeId; x: number; y: number; w: number; logo: string; round?: boolean; title: string; lines: string[] }
interface ArchEdge { from: NodeId; to: NodeId; d: string; label: string; lx: number; ly: number; anchor?: "start" | "middle" | "end" }

const H = 96;
const NODES: ArchNode[] = [
  { id: "app", x: 380, y: 16, w: 320, logo: "/brand/equinox-dark.png", round: true, title: "Equinox app", lines: ["Trade · Pre-IPO · Launch · Portfolio", "trading key signs silently"] },
  { id: "er", x: 40, y: 206, w: 360, logo: "/landing/magicblock.jpg", round: true, title: "MagicBlock Ephemeral Rollup", lines: ["order books · matching · risk checks", "4 markets delegated · 10 ms blocks"] },
  { id: "l1", x: 640, y: 206, w: 400, logo: "/landing/Solana-Round-Logo-PNG.png", round: true, title: "Solana · Equinox program", lines: ["USDC vaults · inbox/outbox receipts", "oracle snapshots · Meteora pools"] },
  { id: "prestocks", x: 20, y: 400, w: 210, logo: "/landing/prestocks.png", round: true, title: "PreStocks", lines: ["pre-IPO token prices"] },
  { id: "mm", x: 262, y: 400, w: 260, logo: "/brand/equinox-dark.png", round: true, title: "Market-maker service", lines: ["maker · keeper · reporter"] },
  { id: "pyth", x: 580, y: 400, w: 210, logo: "/landing/pyth.png", title: "Pyth", lines: ["signed TSLA prices"] },
  { id: "meteora", x: 830, y: 400, w: 230, logo: "/landing/meteora.svg", title: "Meteora", lines: ["DBC launches → DAMM v2"] },
];

const EDGES: ArchEdge[] = [
  { from: "app", to: "er", d: "M 440 112 C 440 165, 230 155, 230 206", label: "orders · 2–15 ms", lx: 300, ly: 160, anchor: "end" },
  { from: "app", to: "l1", d: "M 640 112 C 640 165, 840 155, 840 206", label: "deposits · launches", lx: 790, ly: 160 },
  { from: "er", to: "l1", d: "M 400 240 L 640 240", label: "commit state", lx: 520, ly: 232, anchor: "middle" },
  { from: "l1", to: "er", d: "M 640 274 L 400 274", label: "delegate · clone", lx: 520, ly: 294, anchor: "middle" },
  { from: "prestocks", to: "mm", d: "M 230 448 L 262 448", label: "", lx: 0, ly: 0 },
  { from: "mm", to: "er", d: "M 330 400 L 330 302", label: "quotes · keeper", lx: 336, ly: 356 },
  { from: "mm", to: "l1", d: "M 470 400 C 470 345, 690 365, 690 302", label: "price posts", lx: 560, ly: 352 },
  { from: "pyth", to: "l1", d: "M 760 400 L 760 302", label: "Pyth update", lx: 766, ly: 356 },
  { from: "meteora", to: "l1", d: "M 945 400 L 945 302", label: "pools on L1", lx: 951, ly: 356 },
];

export function ArchitectureScreen({ rate, blockMs }: { rate: number | null; blockMs: number | null }) {
  const [focus, setFocus] = useState<NodeId | null>(null);
  const related = (edge: ArchEdge) => !focus || edge.from === focus || edge.to === focus;
  const lit = (id: NodeId) => !focus || id === focus || EDGES.some((e) => related(e) && (e.from === id || e.to === id));
  const live: Partial<Record<NodeId, string>> = {
    er: blockMs === null ? "live" : `${blockMs} ms in a block`,
    mm: rate === null ? "live" : `${rate.toFixed(1)} tx/s`,
  };

  return (
    <div className={css.pad}>
      <div className={css.screenHead}>
        <div><h3>How Equinox works</h3><p className={css.muted}>Orders match in the rollup, prices are verified on Solana, and USDC never leaves the L1 vault.</p></div>
        <span className={css.chip}>Live on devnet</span>
      </div>

      <svg viewBox="0 0 1080 506" className={css.arch} role="img" aria-label="Equinox architecture diagram">
        <defs>
          <marker id="arch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 z" className={css.archArrow} />
          </marker>
        </defs>
        {EDGES.map((e) => (
          <g key={`${e.from}-${e.to}`} className={css.archEdge} data-dim={!related(e)}>
            <path d={e.d} className={css.archTrack} />
            <path d={e.d} className={css.archFlow} markerEnd="url(#arch-arrow)" />
            <circle r="3.2" className={css.archPulse}>
              <animateMotion dur="2.4s" repeatCount="indefinite" path={e.d} />
            </circle>
            {e.label && <text x={e.lx} y={e.ly} textAnchor={e.anchor ?? "start"} className={css.archLabel}>{e.label}</text>}
          </g>
        ))}
        {NODES.map((n) => (
          <g key={n.id} className={css.archNode} data-dim={!lit(n.id)} data-focus={focus === n.id} tabIndex={0} role="button" aria-label={`${n.title}: ${n.lines.join(", ")}`}
            onMouseEnter={() => setFocus(n.id)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(n.id)} onBlur={() => setFocus(null)}>
            <rect x={n.x} y={n.y} width={n.w} height={H} rx={12} className={css.archBox} />
            <clipPath id={`arch-clip-${n.id}`}><rect x={n.x + 14} y={n.y + 18} width={34} height={34} rx={n.round ? 17 : 8} /></clipPath>
            <image href={n.logo} x={n.x + 14} y={n.y + 18} width={34} height={34} clipPath={`url(#arch-clip-${n.id})`} preserveAspectRatio="xMidYMid slice" />
            <text x={n.x + 60} y={n.y + 30} className={css.archTitle}>{n.title}</text>
            {n.lines.map((line, i) => <text key={line} x={n.x + 60} y={n.y + 49 + i * 16} className={css.archLine}>{line}</text>)}
            {live[n.id] && (
              <g>
                <circle cx={n.x + 64} cy={n.y + 45 + n.lines.length * 16} r={3.5} className={css.archLive} />
                <text x={n.x + 73} y={n.y + 49 + n.lines.length * 16} className={css.archLiveText}>{live[n.id]}</text>
              </g>
            )}
          </g>
        ))}
      </svg>

      <ol className={css.archList}>
        {NODES.map((n) => (
          <li key={n.id} className="glass-card">
            <img src={n.logo} alt="" width={28} height={28} className={n.round ? css.logo : undefined} />
            <span>
              <b>{n.title}</b>
              {live[n.id] && <span className={css.archListLive}>● {live[n.id]}</span>}
              <span className={css.muted}>{n.lines.join(" · ")}</span>
              {EDGES.filter((e) => e.from === n.id && e.label).map((e) => <span key={e.to} className={css.archListEdge}>→ {NODES.find((x) => x.id === e.to)?.title}: {e.label}</span>)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
