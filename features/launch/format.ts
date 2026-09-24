const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/** Dollar amounts from $0.0000000418 to $1.2M, readable at a glance:
 * tiny prices collapse their leading zeros into a subscript count, the
 * way DEX screens do ($4.18e-8 -> "$0.0₇418"). */
export function formatTinyUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1) return `${sign}${abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: abs >= 1000 ? 0 : 2 })}`;
  if (abs >= 0.001) return `${sign}$${abs.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  const zeros = Math.ceil(-Math.log10(abs)) - 1;
  const digits = Math.round(abs * 10 ** (zeros + 3)).toString().slice(0, 3).replace(/0+$/, "") || "0";
  const count = String(zeros).split("").map((d) => SUBSCRIPT[Number(d)]).join("");
  return `${sign}$0.0${count}${digits}`;
}

/** $1,200 -> "$1.2K", $2,500,000 -> "$2.5M". */
export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1_000) return formatTinyUsd(value);
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
}
