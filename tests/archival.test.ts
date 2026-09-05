import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberSystem } from "../src/remember/system.ts";

function system(dir: string, overrides: Record<string, unknown> = {}) {
  return new RememberSystem({
    active_db: join(dir, "active.db"),
    archive_dir: join(dir, "archives") + "/",
    archive_threshold_days: 0,
    archive_min_salience: 0.5,
    auto_archive_enabled: false,
    ...overrides,
  });
}

describe("archival", () => {
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
    const d = mkdtempSync(join(tmpdir(), "remember-arch-"));
    dirs.push(d);
    return d;
  }

  test("archives only low-salience memories and conserves totals", async () => {
    const s = system(tmp());
    await s.addMemory({ content: "High value: the deploy key rotation runbook", tags: ["ops"] });
    await s.addMemory({ content: "Trivia: the office plant needs water", tags: ["misc"] });
    await s.addMemory({ content: "High value: the incident postmortem for 08-13", tags: ["ops"] });

    const before = await s.getStats();
    expect(before.active_count).toBe(3);
    expect(before.archive_count).toBe(0);

    const result = await s.archiveOldMemories({ age_days: 0, min_salience: 0.5 });
    expect(result.archived_count + result.active_remaining).toBe(before.active_count);

    const after = await s.getStats();
    expect(after.active_count).toBe(result.active_remaining);
    expect(after.total_memories).toBe(before.total_memories);
    if (result.archived_count > 0) {
      expect(after.archive_file_count).toBeGreaterThanOrEqual(1);
      expect(after.archive_count).toBe(result.archived_count);
    }
    s.close();
  }, 120_000);

  test("default user archive is recorded under 'default'", async () => {
    const s = system(tmp());
    for (const text of ["alpha runbook", "beta postmortem", "gamma trivia"]) {
      await s.addMemory({ content: text, tags: ["t"] });
    }
    const result = await s.archiveOldMemories({
      age_days: 0,
      min_salience: 1.0,
      user_id: null,
    });
    expect(result.archived_count).toBeGreaterThan(0);
    expect(Object.keys(s.archiveIndex).length).toBeGreaterThan(0);
    expect("default" in s.archiveIndex).toBe(true);
    const after = await s.getStats();
    expect(after.archive_count).toBeGreaterThan(0);
    s.close();
  }, 120_000);

  test("archiving nothing is a no-op", async () => {
    const s = system(tmp());
    await s.addMemory({ content: "keep me", tags: ["k"] });
    const before = await s.getStats();
    const result = await s.archiveOldMemories({ age_days: 0, min_salience: -1 });
    expect(result.archived_count).toBe(0);
    const after = await s.getStats();
    expect(after.active_count).toBe(before.active_count);
    s.close();
  });

  test("age_days=0 is not treated as missing", async () => {
    const s = system(tmp(), { archive_threshold_days: 60 });
    await s.addMemory({ content: "fresh memory to archive now", tags: ["t"] });
    const result = await s.archiveOldMemories({ age_days: 0, min_salience: 1.0 });
    expect(result.archived_count).toBe(1);
    s.close();
  }, 120_000);
});
