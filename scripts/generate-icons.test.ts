import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("does not run the standalone icon CLI when imported by the build", async () => {
  const directory = mkdtempSync(join(tmpdir(), "focusdeck-icons-"));
  const target = join(directory, "chrome");
  const previousArgs = process.argv;
  try {
    process.argv = [process.execPath, join(process.cwd(), "scripts/build.ts"), target];
    await import("./generate-icons");
    expect(existsSync(target)).toBe(false);
  } finally {
    process.argv = previousArgs;
    rmSync(directory, { recursive: true, force: true });
  }
});
