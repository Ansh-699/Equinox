/** Bounded exponential backoff, shared by `keepers.ts` (keeper retry
 * scheduling) and `repositories.ts` (`DeadLetterRepository`'s retry
 * scheduling) -- pulled out on its own so neither module has to import
 * the other just for this one function. */
export function retryDelay(attempt: number, baseMs = 250, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
