import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Models are served straight from the repository data dir via /@fs (no 300MB copies).
const repoDir = resolve(__dirname, "../..");
const modelsDir = resolve(repoDir, "data/onnx-lean");

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      // ORT does not expose a subpath for its external-WASM entry.
      "onnxruntime-web/wasm": resolve(
        __dirname,
        "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
      ),
    },
  },
  define: {
    __MODELS_URL__: JSON.stringify(
      command === "serve" ? `/@fs${modelsDir}` : null,
    ),
  },
  optimizeDeps: {
    // keep ort un-prebundled so its internal import.meta.url asset resolution works in dev
    exclude: ["onnxruntime-web"],
  },
  server: {
    headers: {
      // cross-origin isolation for threaded ort-wasm (SharedArrayBuffer)
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // allow serving the wasm pkg and model files from the repository
      allow: [repoDir],
    },
  },
}));
