export function decimal(value: string, scale: number): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? raw / scale : Number.NaN;
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
