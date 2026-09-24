/** The same supplied Equinox mark across the app, with a fixed dark variant
 * for surfaces that stay dark even when the terminal uses light mode. */
export function BrandMark({
  size,
  darkSurface = false,
  className = "",
}: {
  size: number;
  darkSurface?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`brand-mark ${darkSurface ? "brand-mark-on-dark" : ""} ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
