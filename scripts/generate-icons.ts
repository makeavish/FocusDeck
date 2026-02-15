import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const svgPath = join(repoRoot, "src", "icons", "icon.svg");
const svgBuffer = readFileSync(svgPath);

const SIZES = [16, 32, 48, 128];

export async function generateIcons(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  for (const size of SIZES) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(join(outDir, `icon-${size}.png`));
  }
}

// Allow running standalone: tsx scripts/generate-icons.ts <outDir>
const standaloneTarget = process.argv[2];
if (standaloneTarget) {
  void generateIcons(resolve(standaloneTarget)).then(() => {
    console.log(`Generated icons (${SIZES.join(", ")}px) -> ${standaloneTarget}`);
  });
}
