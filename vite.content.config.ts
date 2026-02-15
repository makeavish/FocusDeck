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
    emptyOutDir: false,
    sourcemap: !process.env.RELEASE,
    rollupOptions: {
      input: resolve(root, "content/index.ts"),
      output: {
        entryFileNames: "content.js",
        inlineDynamicImports: true,
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
}));
