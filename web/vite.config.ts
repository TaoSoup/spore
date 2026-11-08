import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The API/indexer (app/server) runs on :8793 in development; production serves the built
// app from the same server, so every request is same-origin.
const API = `http://127.0.0.1:${process.env.API_PORT || 8793}`;
export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ["buffer", "process", "stream", "util", "events"], globals: { Buffer: true, process: true } })],
  define: { "process.env.NODE_DEBUG": "false" },
  // /v1 is the read-only partner API (DESIGN §12); /embed/* are pages of this app, served by Vite itself.
  server: { port: 5174, proxy: { "/api": API, "/v1": API, "^/m/": API } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
  // map3 (src/components/map3): pre-bundle three and the postprocessing addons, so the first /map visit in dev does not
  // discover them mid-session and force a full reload (spec 4.15).
  optimizeDeps: { include: ["three", "three/addons/postprocessing/EffectComposer.js", "three/addons/postprocessing/RenderPass.js", "three/addons/postprocessing/UnrealBloomPass.js", "three/addons/postprocessing/OutputPass.js", "three/addons/postprocessing/Pass.js"] },
});
