/** Persists only the selected wallet's PUBLIC address -- never key material,
 * never Privy tokens. localStorage is per-browser, per-viewer convenience
 * only: it is never treated as authoritative (the selection is always
 * re-validated against the currently discovered wallet list before use). */
const STORAGE_KEY = "stockstream:selectedWallet";

export function readStoredWallet(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeSelectedWallet(address: string | null): void {
  try {
    if (address) localStorage.setItem(STORAGE_KEY, address);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing / blocked storage: selection just won't survive reload. Not fatal.
  }
}
