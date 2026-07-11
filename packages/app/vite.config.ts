import { defineConfig } from "vite";
import { resolve } from "node:path";

// Models are served straight from the repository data dir via /@fs (no 300MB copies).
const repoDir = resolve(__dirname, "../..");
const modelsDir = resolve(repoDir, "data/onnx-lean");

export default defineConfig({
  define: {
    __MODELS_URL__: JSON.stringify(`/@fs${modelsDir}`),
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
});
