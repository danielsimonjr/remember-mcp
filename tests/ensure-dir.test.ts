import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../src/remember/ensure-dir.ts";

describe("ensureDir", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function tmp() {
    const d = mkdtempSync(join(tmpdir(), "remember-ensure-"));
    dirs.push(d);
    return d;
  }

  test("creates a folder and its missing parents", () => {
    const base = tmp();
    ensureDir(join(base, "a", "b", "c"));
    expect(existsSync(join(base, "a", "b", "c"))).toBe(true);
  });

  test("accepts a folder that exists", () => {
    const base = tmp();
    ensureDir(base);
    ensureDir(`${base}/`);
    expect(existsSync(base)).toBe(true);
  });

  test("accepts the names of the current and the parent folder", () => {
    ensureDir(".");
    ensureDir("..");
    ensureDir("./");
    ensureDir("../");
  });

  test("throws for a path that names a file", () => {
    const base = tmp();
    const file = join(base, "plain.txt");
    writeFileSync(file, "x");
    expect(() => ensureDir(file)).toThrow();
  });
});
