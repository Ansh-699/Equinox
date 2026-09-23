/** Extracts events from any Worker market-stream payload: the per-domain
 * snapshot (`{ domains: [{ events }] }`), the legacy flat snapshot
 * (`{ events }`), or a single pushed event. Unknown shapes yield no events. */
export function marketStreamEvents<T>(data: unknown): T[] {
  if (!data || typeof data !== "object") return [];
  if ("domains" in data && Array.isArray(data.domains)) {
    return data.domains.flatMap((domain: { events?: unknown }) => (Array.isArray(domain?.events) ? domain.events as T[] : []));
  }
  if ("events" in data) return Array.isArray(data.events) ? data.events as T[] : [];
  return "kind" in data ? [data as T] : [];
}
