import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoDir = resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // ORT does not expose a subpath for its external-WASM entry.
      "onnxruntime-web/wasm": resolve(
        __dirname,
        "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
      ),
    },
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
      // Allow serving the generated WASM package from the repository.
      allow: [repoDir],
    },
  },
});
