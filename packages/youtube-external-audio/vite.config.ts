import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    minify: false,
    copyPublicDir: true,
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
