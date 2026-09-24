import type { Metadata } from "next";
import { IBM_Plex_Mono, Poppins } from "next/font/google";
import { AppProviders } from "@/components/app-providers";
import { THEME_SCRIPT } from "@/components/theme-toggle";
import "./globals.css";

const poppins = Poppins({ variable: "--font-poppins", weight: ["400", "500", "600", "700"], subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500", "600"], subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Equinox",
  description: "Perpetual futures on US stocks: matched in a MagicBlock Ephemeral Rollup, priced by Pyth, settled on Solana.",
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
