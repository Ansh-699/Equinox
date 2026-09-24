"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";

/** Shared building blocks for the account pages, drawer and launchpad. All
 * colours come from the --t-* tokens in app/globals.css, so light and dark
 * themes stay in step. */

export const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t-up)]";

export function Card({ title, action, children, className = "", bodyClassName = "p-4", as: Tag = "section", ...rest }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: "section" | "div" | "aside";
  "aria-label"?: string;
}) {
  return (
    <Tag className={`rounded-[10px] border border-[var(--t-border)] bg-[var(--t-surface)] ${className}`} {...rest}>
      {title || action ? (
        <div className="flex min-h-[44px] items-center justify-between gap-3 border-b border-[var(--t-border)] px-4 py-2">
          {typeof title === "string" ? <h2 className="text-[13px] font-semibold text-[var(--t-text)]">{title}</h2> : title}
          {action}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </Tag>
  );
}

export type Tone = "up" | "down" | "warn" | "muted" | "neutral" | "link";

const TONE_TEXT: Record<Tone, string> = {
  up: "text-[var(--t-up)]",
  down: "text-[var(--t-down)]",
  warn: "text-[var(--t-warn)]",
  muted: "text-[var(--t-text-2)]",
  neutral: "text-[var(--t-text)]",
  link: "text-[var(--t-link)]",
};

const TONE_BADGE: Record<Tone, string> = {
  up: "bg-[var(--t-up-soft)] text-[var(--t-up)]",
  down: "bg-[var(--t-down-soft)] text-[var(--t-down)]",
  warn: "bg-[rgba(245,158,11,0.14)] text-[var(--t-warn)]",
  muted: "bg-[var(--t-surface-3)] text-[var(--t-text-2)]",
  neutral: "bg-[var(--t-surface-3)] text-[var(--t-text)]",
  link: "bg-[rgba(56,139,253,0.12)] text-[var(--t-link)]",
};

export function Badge({ tone = "muted", children, dot = false, className = "" }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.02em] ${TONE_BADGE[tone]} ${className}`}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function StatTile({ label, value, hint, tone = "neutral", size = "md", loading = false }: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const valueSize = size === "lg" ? "text-[22px]" : size === "sm" ? "text-[14px]" : "text-[17px]";
  return (
    <div className="min-w-0 rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--t-text-3)]">{label}</div>
      <div className={`tnum mt-1 truncate font-semibold ${valueSize} ${TONE_TEXT[tone]}`}>
        {loading ? <Skeleton className={size === "lg" ? "h-[26px] w-24" : "h-[20px] w-16"} /> : value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-[var(--t-text-3)]">{hint}</div> : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block animate-pulse rounded-[4px] bg-[var(--t-surface-3)] align-middle ${className}`} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      {icon ? <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--t-surface-3)] text-[var(--t-text-2)]">{icon}</div> : null}
      <p className="text-[13px] font-semibold text-[var(--t-text)]">{title}</p>
      {children ? <div className="max-w-[40ch] text-[12px] leading-relaxed text-[var(--t-text-2)]">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function SegmentedTabs<T extends string>({ tabs, value, onChange, label, className = "" }: {
  tabs: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={`flex gap-1 rounded-[8px] bg-[var(--t-surface-3)] p-1 ${className}`}>
      {tabs.map((tab) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            className={`h-[28px] flex-1 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${FOCUS_RING} ${on ? "bg-[var(--t-bg)] text-[var(--t-text)] shadow-sm" : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small (i) with the explanation in a native tooltip and for screen readers. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="inline-flex cursor-help align-middle text-[var(--t-text-3)]" title={text}>
      <Info className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  );
}

export const BUTTON_PRIMARY = `inline-flex h-[36px] items-center justify-center gap-2 rounded-[8px] bg-[var(--t-up-3)] px-4 text-[13px] font-semibold text-[var(--t-on-fill)] transition-colors hover:bg-[var(--t-up-2)] disabled:cursor-not-allowed disabled:bg-[var(--t-surface-3)] disabled:text-[var(--t-text-2)] ${FOCUS_RING}`;
export const BUTTON_SECONDARY = `inline-flex h-[36px] items-center justify-center gap-2 rounded-[8px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-4 text-[13px] font-medium text-[var(--t-text)] transition-colors hover:bg-[var(--t-surface-3)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;
export const BUTTON_DANGER = `inline-flex h-[34px] items-center justify-center gap-2 rounded-[8px] border border-[var(--t-down)] px-3 text-[12.5px] font-medium text-[var(--t-down)] transition-colors hover:bg-[var(--t-down-soft)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;

/** 6-decimal collateral base units -> "$1,234.56". */
export function formatUsdUnits(units: bigint | null | undefined): string {
  if (units === null || units === undefined) return "—";
  const negative = units < 0n;
  const value = Number(negative ? -units : units) / 1e6;
  return `${negative ? "-" : ""}$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSol(lamports: bigint | null | undefined, digits = 3): string {
  if (lamports === null || lamports === undefined) return "—";
  return `${(Number(lamports) / 1e9).toFixed(digits)} SOL`;
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}
