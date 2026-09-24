"use client";

import { useCallback, useState } from "react";

export interface TxToast { id: number; ok: boolean; pending?: boolean; title: string; detail?: string; href?: string }

/** Transaction toasts: newest on top, each gone after a few seconds. */
export function useTxToasts() {
  const [toasts, setToasts] = useState<TxToast[]>([]);
  const dismissLater = (id: number, ok: boolean) => setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), ok ? 4_000 : 7_000);
  const push = useCallback((toast: Omit<TxToast, "id">) => {
    const id = performance.now() + Math.random();
    setToasts((current) => [{ ...toast, id }, ...current].slice(0, 5));
    if (!toast.pending) dismissLater(id, toast.ok);
    return id;
  }, []);
  /** Settles a pending toast in place (same card: no flicker). */
  const settle = useCallback((id: number, patch: Omit<TxToast, "id" | "pending">) => {
    setToasts((current) => current.map((t) => (t.id === id ? { ...t, ...patch, pending: false } : t)));
    dismissLater(id, patch.ok);
  }, []);
  return { toasts, push, settle };
}

export function TxToasts({ toasts }: { toasts: readonly TxToast[] }) {
  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-50 flex w-[300px] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} role="status" className="pointer-events-auto flex items-start gap-2.5 rounded-[8px] border border-[var(--t-border)] bg-[var(--t-bg)] px-3 py-2.5 shadow-lg">
          <span className={`mt-[3px] h-2 w-2 flex-none rounded-full ${toast.pending ? "animate-pulse bg-[var(--t-text-3)]" : toast.ok ? "bg-[var(--t-up)]" : "bg-[var(--t-down)]"}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-[var(--t-text)]">{toast.title}</p>
            {toast.detail ? <p className="tnum mt-0.5 truncate text-[11.5px] text-[var(--t-text-2)]">{toast.detail}</p> : null}
          </div>
          {toast.href ? (
            <a href={toast.href} target="_blank" rel="noreferrer" className="flex-none text-[12px] font-medium text-[var(--t-text-2)] hover:text-[var(--t-text)]" aria-label="View transaction">View ↗</a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
