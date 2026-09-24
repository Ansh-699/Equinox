import { LandingView } from "@/features/landing/landing-view";

export default function Home() {
  return <LandingView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
