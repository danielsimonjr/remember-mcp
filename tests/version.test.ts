import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/remember/index.ts";
import { PKG_VERSION } from "../src/version.ts";
import packageJson from "../package.json" with { type: "json" };

describe("version", () => {
  test("package export matches package.json", () => {
    expect(VERSION).toBe(packageJson.version);
    expect(PKG_VERSION).toBe(packageJson.version);
  });
});
