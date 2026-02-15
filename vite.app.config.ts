import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "src");

export default defineConfig(({ mode }) => ({
  root,
  publicDir: false,
  resolve: {
    alias: {
      "@": root
    }
  },
  build: {
    outDir: resolve(__dirname, "dist", mode),
    emptyOutDir: true,
    sourcemap: !process.env.RELEASE,
    rollupOptions: {
      input: {
        background: resolve(root, "background/service-worker.ts"),
        settings: resolve(root, "settings/settings.html")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
}));
