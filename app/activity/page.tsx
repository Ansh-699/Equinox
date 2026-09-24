import { ActivityView } from "@/features/activity/activity-view";

export default function ActivityPage() {
  return <ActivityView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
