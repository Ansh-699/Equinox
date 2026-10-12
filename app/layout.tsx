import type { Metadata } from "next";
import { IBM_Plex_Mono, Poppins } from "next/font/google";
import { AppProviders } from "@/components/app-providers";
import { THEME_SCRIPT } from "@/components/theme-toggle";
import "./globals.css";

// Poppins for text and IBM Plex Mono for numbers, the ordr.trade pairing.
const poppins = Poppins({ variable: "--font-poppins", weight: ["400", "500", "600", "700"], subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500", "600"], subsets: ["latin"], display: "swap" });

const DESCRIPTION = "Perpetual futures on tokenized assets at rollup speed: TSLA and pre-IPO OpenAI, SpaceX, Anthropic, matched in 2–15 ms on a MagicBlock Ephemeral Rollup, with USDC custody on Solana.";

export const metadata: Metadata = {
  metadataBase: new URL("https://equinox.ansht.workers.dev"),
  title: "Equinox",
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Equinox", title: "Equinox: perps on tokenized assets at rollup speed", description: DESCRIPTION, url: "/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Equinox: perpetual futures on tokenized assets at rollup speed" }] },
  twitter: { card: "summary_large_image", title: "Equinox: perps on tokenized assets at rollup speed", description: DESCRIPTION, images: ["/og.png"] },
  icons: {
    icon: "/equinox-favicon.png",
    apple: "/equinox-favicon.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${poppins.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Before first paint: honour a stored light-mode choice without a flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
