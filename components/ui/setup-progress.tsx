"use client";

import { Check } from "lucide-react";

const STEPS = ["Fund", "Account", "Deposit"] as const;
const RING = 2 * Math.PI * 22;

/** "2/3 · Opening margin account…" → step 2 and its label; null for anything else. */
export function parseSetupStep(text: string | null): { step: 1 | 2 | 3; label: string } | null {
  const match = text?.match(/^([123])\/3 · (.+)$/);
  return match ? { step: Number(match[1]) as 1 | 2 | 3, label: match[2] } : null;
}

/** The three setup steps (fund → margin account → deposit) around the MagicBlock
 * mark: the ring fills a third per step while a comet orbits the current one,
 * and `done` closes the ring with a check. */
export function SetupProgress({ step, label, done = false }: { step: 1 | 2 | 3; label: string; done?: boolean }) {
  const filled = done ? 3 : step - 1;
  return (
    <div role="status" aria-live="polite" aria-label={done ? "Setup complete" : `Step ${step} of 3: ${label}`} className="setup-progress flex items-center gap-3 px-3 py-2.5">
      <div className="relative h-[52px] w-[52px] shrink-0">
        <svg viewBox="0 0 52 52" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="26" cy="26" r="22" fill="none" strokeWidth="3" className="stroke-[var(--t-surface-3)]" />
          <circle cx="26" cy="26" r="22" fill="none" strokeWidth="3" strokeLinecap="round" className="setup-ring stroke-[var(--t-up)]"
            strokeDasharray={RING} strokeDashoffset={RING * (1 - filled / 3)} />
        </svg>
        {done ? null : <span aria-hidden className="setup-comet absolute inset-0" />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/landing/magicblock.jpg" alt="" className={`setup-mark absolute inset-[9px] h-[34px] w-[34px] rounded-full object-cover ${done ? "setup-mark-done" : ""}`} />
        {done ? <span aria-hidden className="setup-check absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--t-up)] text-[var(--t-on-fill)]"><Check size={12} strokeWidth={3} /></span> : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-[var(--t-text)]">{done ? "You're set: session live in the rollup" : label}</p>
        <ol className="mt-1.5 flex items-center gap-1.5" aria-hidden>
          {STEPS.map((name, index) => {
            const state = index < filled ? "done" : index === step - 1 && !done ? "now" : "todo";
            return (
              <li key={name} className="flex items-center gap-1.5">
                {index > 0 ? <span className={`h-px w-3 ${index <= filled ? "bg-[var(--t-up)]" : "bg-[var(--t-border-strong)]"}`} /> : null}
                <span className={`flex items-center gap-1 text-[10.5px] ${state === "todo" ? "text-[var(--t-text-3)]" : "text-[var(--t-text)]"}`}>
                  <span className={`grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold ${state === "done" ? "bg-[var(--t-up)] text-[var(--t-on-fill)]" : state === "now" ? "setup-dot-now border border-[var(--t-up)] text-[var(--t-up)]" : "border border-[var(--t-border-strong)]"}`}>
                    {state === "done" ? <Check size={9} strokeWidth={3.5} /> : index + 1}
                  </span>
                  {name}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
