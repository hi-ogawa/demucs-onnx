import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/extension",
    minify: false,
    rolldownOptions: {
      input: {
        content: "./src/content.ts",
      },
      output: {
        format: "iife",
        entryFileNames: "[name].js",
      },
    },
  },
});
