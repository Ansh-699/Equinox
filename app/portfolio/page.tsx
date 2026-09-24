import { PortfolioView } from "@/features/portfolio/portfolio-view";

export default function PortfolioPage() {
  return <PortfolioView />;
}

// No request-time data: render once, serve the HTML from cache.
export const dynamic = "force-static";
