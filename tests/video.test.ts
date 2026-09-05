import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberSystem } from "../src/remember/system.ts";
import { encodeChunks, searchSidecar } from "../src/remember/archive.ts";

describe("archive video", () => {
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

  test("encode + search round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remember-video-"));
    dirs.push(dir);
    const video = join(dir, "t.mp4");
    const index = join(dir, "t.json");
    const chunks = [
      "alpha deploy runbook for staging",
      "beta incident postmortem notes",
      "gamma office plant watering schedule",
    ];
    const stats = await encodeChunks(chunks, video, index);
    expect(stats.chunk_count).toBe(3);
    expect(stats.video_size).toBeGreaterThan(0);

    const hits = searchSidecar(index, "deploy runbook staging", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toMatch(/deploy|runbook/i);
  }, 120_000);

  test("query reaches archived memories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remember-qarch-"));
    dirs.push(dir);
    const s = new RememberSystem({
      active_db: join(dir, "active.db"),
      archive_dir: join(dir, "archives") + "/",
      archive_threshold_days: 0,
      archive_min_salience: 1.0,
    });
    await s.addMemory({
      content: "The blue-green release checklist lives in the ops wiki",
      tags: ["ops"],
    });
    const archived = await s.archiveOldMemories({ age_days: 0, min_salience: 1.0 });
    expect(archived.archived_count).toBe(1);

    const hits = await s.query({
      query: "blue-green release checklist",
      k: 5,
      include_archive: true,
    });
    expect(hits.some((h) => h.location === "archive")).toBe(true);
    s.close();
  }, 120_000);
});
