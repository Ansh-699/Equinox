import { DiagnosticsView } from "@/features/diagnostics/diagnostics-view";

export default function DiagnosticsPage() {
  return <DiagnosticsView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
