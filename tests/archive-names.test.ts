import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberSystem } from "../src/remember/system.ts";

function system(dir: string) {
  return new RememberSystem({
    active_db: join(dir, "active.db"),
    archive_dir: join(dir, "archives") + "/",
    archive_threshold_days: 0,
    archive_min_salience: 0.5,
    auto_archive_enabled: false,
  });
}

describe("archive names", () => {
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
    const d = mkdtempSync(join(tmpdir(), "remember-names-"));
    dirs.push(d);
    return d;
  }

  /** Run `fn` while `Date.now()` returns one fixed value, so every archive pass falls in the same second. */
  async function atFixedTime<T>(fixedMs: number, fn: () => Promise<T>): Promise<T> {
    const spy = spyOn(Date, "now").mockReturnValue(fixedMs);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  const archive = (s: RememberSystem) => s.archiveOldMemories({ age_days: 0, min_salience: 1.0 });

  test("two passes in the same second keep both archives", async () => {
    const dir = tmp();
    const s = system(dir);
    const fixedMs = Date.now() + 60_000;

    await s.addMemory({ content: "alpha runbook for the deploy key rotation" });
    const first = await atFixedTime(fixedMs, () => archive(s));
    await s.addMemory({ content: "beta postmortem for the storage incident" });
    const second = await atFixedTime(fixedMs, () => archive(s));

    expect(first.archived_count).toBe(1);
    expect(second.archived_count).toBe(1);
    expect(Object.keys(s.archiveIndex["default"] ?? {}).length).toBe(2);
    const files = readdirSync(join(dir, "archives"));
    expect(files.filter((f) => f.endsWith(".mp4")).length).toBe(2);
    expect(files.filter((f) => f.endsWith(".json")).length).toBe(2);

    const stats = await s.getStats();
    expect(stats.archive_count).toBe(2);
    expect(stats.active_count).toBe(0);
    for (const probe of ["alpha runbook deploy key", "beta postmortem storage incident"]) {
      const hits = await s.query({ query: probe, k: 5 });
      expect(hits.some((h) => h.location === "archive" && h.content.includes(probe.split(" ")[0]!))).toBe(true);
    }
    s.close();
  }, 120_000);

  test("a pass skips a name that a file on disk already holds", async () => {
    const dir = tmp();
    const s = system(dir);
    const fixedMs = Date.now() + 60_000;
    const second = Math.floor(fixedMs / 1000);
    const orphanVideo = join(dir, "archives", `user_default_${second}.mp4`);
    const orphanIndex = join(dir, "archives", `user_default_${second}.json`);
    writeFileSync(orphanVideo, "orphan video");
    writeFileSync(orphanIndex, "orphan sidecar");

    await s.addMemory({ content: "gamma note for the orphan check" });
    const result = await atFixedTime(fixedMs, () => archive(s));

    expect(result.archived_count).toBe(1);
    expect(readFileSync(orphanVideo, "utf8")).toBe("orphan video");
    expect(readFileSync(orphanIndex, "utf8")).toBe("orphan sidecar");
    expect(Object.keys(s.archiveIndex["default"] ?? {})).toEqual([String(second + 1)]);
    expect(existsSync(join(dir, "archives", `user_default_${second + 1}.mp4`))).toBe(true);
    s.close();
  }, 120_000);

  test("a restart rebuilds the index of both archives", async () => {
    const dir = tmp();
    const s = system(dir);
    const fixedMs = Date.now() + 60_000;
    await s.addMemory({ content: "delta runbook one" });
    await atFixedTime(fixedMs, () => archive(s));
    await s.addMemory({ content: "epsilon runbook two" });
    await atFixedTime(fixedMs, () => archive(s));
    s.close();

    const again = system(dir);
    expect(Object.keys(again.archiveIndex["default"] ?? {}).length).toBe(2);
    expect((await again.getStats()).archive_count).toBe(2);
    again.close();
  }, 120_000);
});
