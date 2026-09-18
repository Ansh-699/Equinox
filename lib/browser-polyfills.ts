import { Buffer } from "buffer";

declare global {
  interface Window { Buffer: typeof Buffer; }
}

// @solana/web3.js and the generated StockStream client construct instruction
// data with the Node `Buffer` global. Next.js's browser bundle does not
// provide one, so any on-chain instruction built client-side throws
// "Buffer is not defined" without this. Import this module once from a
// client boundary that always mounts (components/app-providers.tsx).
if (typeof window !== "undefined" && !window.Buffer) {
  window.Buffer = Buffer;
}
