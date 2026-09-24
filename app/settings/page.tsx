import { SettingsView } from "@/features/settings/settings-view";

export default function SettingsPage() {
  return <SettingsView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
