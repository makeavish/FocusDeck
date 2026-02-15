import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateIcons } from "./generate-icons.js";

const browser = process.argv[2];

if (browser !== "chrome" && browser !== "firefox") {
  console.error("Expected browser target: chrome or firefox");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const appBuild = spawnSync("npx", ["vite", "build", "--config", "vite.app.config.ts", "--mode", browser], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (appBuild.status !== 0) {
  process.exit(appBuild.status ?? 1);
}

const contentBuild = spawnSync("npx", ["vite", "build", "--config", "vite.content.config.ts", "--mode", browser], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (contentBuild.status !== 0) {
  process.exit(contentBuild.status ?? 1);
}

const distDir = join(repoRoot, "dist", browser);
mkdirSync(distDir, { recursive: true });
copyFileSync(join(repoRoot, "src", `manifest.${browser}.json`), join(distDir, "manifest.json"));

const iconsDir = join(distDir, "icons");
await generateIcons(iconsDir);

console.log(`Built FocusDeck for ${browser} -> dist/${browser}`);
