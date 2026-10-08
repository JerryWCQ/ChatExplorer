import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-manifest",
      closeBundle() {
        mkdirSync(resolve("dist"), { recursive: true });
        copyFileSync(resolve("manifest.json"), resolve("dist/manifest.json"));
      }
    }
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        app: resolve("app.html"),
        // Ships with the extension so the gallery can be opened from Settings
        // and checked against the real browser, not just the dev server.
        showcase: resolve("showcase.html"),
        background: resolve("src/background/index.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
