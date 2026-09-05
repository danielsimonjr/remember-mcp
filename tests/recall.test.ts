import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberSystem } from "../src/remember/system.ts";

function system(dir: string) {
  return new RememberSystem({
    active_db: join(dir, "active.db"),
    archive_dir: join(dir, "archives") + "/",
    archive_threshold_days: 0,
    archive_min_salience: 1.0,
    auto_archive_enabled: false,
  });
}

describe("recall", () => {
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
    const d = mkdtempSync(join(tmpdir(), "remember-recall-"));
    dirs.push(d);
    return d;
  }

  test("archived memory can be recalled", async () => {
    const s = system(tmp());
    const content = "The staging cluster credentials rotate every ninety days";
    await s.addMemory({ content, tags: ["ops"] });

    const archived = await s.archiveOldMemories({ age_days: 0, min_salience: 1.0 });
    expect(archived.archived_count).toBeGreaterThanOrEqual(1);

    const emptied = await s.getStats();
    expect(emptied.active_count).toBe(0);

    const key = Object.keys(s.archiveIndex)[0]!;
    const timestamp = Object.keys(s.archiveIndex[key]!)[0]!;
    const archiveFile = `user_${key}_${timestamp}`;

    await s.recallFromArchive({
      archive_file: archiveFile,
      content,
      user_id: null,
    });

    const restored = await s.getStats();
    expect(restored.active_count).toBeGreaterThan(emptied.active_count);
    s.close();
  }, 120_000);

  test("recall of unknown archive does not corrupt active", async () => {
    const s = system(tmp());
    await s.addMemory({ content: "a real memory", tags: ["keep"] });
    const before = await s.getStats();

    let threw = false;
    try {
      await s.recallFromArchive({
        archive_file: "user_default_0000000000",
        content: "something that was never archived",
        user_id: null,
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("FileNotFoundError");
      expect((err as Error).message).toMatch(/Unknown archive/);
    }
    expect(threw).toBe(true);

    const after = await s.getStats();
    expect(after.active_count).toBe(before.active_count);
    s.close();
  });
});
