import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/extension",
    minify: false,
    rolldownOptions: {
      input: {
        content: "./src/content.tsx",
      },
      output: {
        format: "iife",
        entryFileNames: "[name].js",
      },
    },
  },
});
