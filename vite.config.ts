import { defaultServerConditions, defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

// Several Solana dependencies (rpc-websockets, older @solana/codecs) export only
// "browser"/"node" builds. Their browser builds use the global fetch/WebSocket
// that workerd provides, so the Workers server environments fall back to them.
const workerConditions = { resolve: { conditions: [...defaultServerConditions, "workerd", "worker", "browser"] } };

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
  environments: { rsc: workerConditions, ssr: workerConditions },
});
