import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Models are served straight from the repository data dir via /@fs (no 300MB copies).
const repoDir = resolve(__dirname, "../..");
const modelsDir = resolve(repoDir, "data/onnx-lean");

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __MODELS_URL__: JSON.stringify(
      command === "serve" ? `/@fs${modelsDir}` : null,
    ),
  },
  server: {
    headers: {
      // cross-origin isolation for threaded ort-wasm (SharedArrayBuffer)
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
}));
