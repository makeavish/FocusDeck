import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const iconsDir = join(repoRoot, "src", "icons");
const toolbarSvg = readFileSync(join(iconsDir, "icon-toolbar.svg"));
const storeSvg = readFileSync(join(iconsDir, "icon.svg"));

// Toolbar sizes use a full-bleed 16px-grid source; the 128px store icon keeps Chrome's 16px padding.
const ICONS = [
  { size: 16, svg: toolbarSvg, viewBox: 16 },
  { size: 32, svg: toolbarSvg, viewBox: 16 },
  { size: 48, svg: toolbarSvg, viewBox: 16 },
  { size: 128, svg: storeSvg, viewBox: 128 }
];
const SIZES = ICONS.map((icon) => icon.size);

export async function generateIcons(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  for (const { size, svg, viewBox } of ICONS) {
    // Rasterize at the target size so the 16px grid isn't upscaled from a 16px bitmap.
    await sharp(svg, { density: (72 * size) / viewBox })
      .resize(size, size)
      .png()
      .toFile(join(outDir, `icon-${size}.png`));
  }
}

// Allow running standalone: tsx scripts/generate-icons.ts <outDir>
const standaloneTarget = process.argv[2];
if (standaloneTarget && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void generateIcons(resolve(standaloneTarget)).then(() => {
    console.log(`Generated icons (${SIZES.join(", ")}px) -> ${standaloneTarget}`);
  });
}
