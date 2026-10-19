import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { RememberSystem } from "../src/remember/system.ts";
import { encodeChunks, loadSidecar, searchSidecar } from "../src/remember/archive.ts";

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

  test("archives a memory of more than 800 CJK characters together with an ASCII memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remember-cjk-arch-"));
    dirs.push(dir);
    const s = new RememberSystem({
      active_db: join(dir, "active.db"),
      archive_dir: join(dir, "archives") + "/",
      archive_threshold_days: 0,
      archive_min_salience: 1.0,
    });
    await s.addMemory({ content: "漢".repeat(1200), tags: ["cjk"] });
    await s.addMemory({ content: "The ASCII memory that shares the archive pass" });

    const archived = await s.archiveOldMemories({ age_days: 0, min_salience: 1.0 });
    expect(archived.archived_count).toBe(2);
    expect(archived.active_remaining).toBe(0);
    s.close();
  }, 120_000);
});

/**
 * The frame size of the QR archive.
 * A frame holds 2331 bytes at error correction level M, so the limit that matters is a byte limit.
 * Each test encodes one chunk and reads the text of every frame from the call to the QR library.
 */
describe("QR frames", () => {
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

  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const codePoints = (text: string) => [...text].length;
  // A lone surrogate becomes U+FFFD when the text is encoded, so only well-formed text comes back equal.
  const roundTrips = (text: string) => new TextDecoder().decode(new TextEncoder().encode(text)) === text;

  async function framesOf(chunk: string): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "remember-frames-test-"));
    dirs.push(dir);
    const spy = spyOn(QRCode, "toFile");
    try {
      await encodeChunks([chunk], join(dir, "t.mp4"), join(dir, "t.json"));
      return spy.mock.calls.map((call) => String(call[1]));
    } finally {
      spy.mockRestore();
    }
  }

  test("keeps a chunk of 800 ASCII characters in one frame", async () => {
    const chunk = "a".repeat(800);
    expect(await framesOf(chunk)).toEqual([chunk]);
  }, 120_000);

  test("cuts ASCII text after 800 characters", async () => {
    const frames = await framesOf("a".repeat(801));
    expect(frames.map((frame) => frame.length)).toEqual([800, 1]);
  }, 120_000);

  test("fills a frame to exactly 800 bytes and cuts at the next character", async () => {
    const full = "😀".repeat(200);
    expect(bytes(full)).toBe(800);
    expect(await framesOf(full)).toEqual([full]);

    const frames = await framesOf("😀".repeat(201));
    expect(frames.map(codePoints)).toEqual([200, 1]);
  }, 120_000);

  test("cuts before a character that would pass the byte budget", async () => {
    const frames = await framesOf("a".repeat(799) + "漢");
    expect(frames).toEqual(["a".repeat(799), "漢"]);
  }, 120_000);

  test("encodes a CJK chunk that is longer than one frame", async () => {
    const chunk = "漢".repeat(1024);
    const frames = await framesOf(chunk);
    expect(frames.length).toBe(4);
    for (const frame of frames) expect(bytes(frame)).toBeLessThanOrEqual(800);
    expect(frames.join("")).toBe(chunk);
  }, 120_000);

  test("never cuts inside a surrogate pair", async () => {
    // A prefix of one or three ASCII bytes moves every pair by an odd number of UTF-16 units,
    // so a cut that counts units or bytes in the wrong place falls inside a pair.
    for (const prefix of ["", "a", "aaa"]) {
      const chunk = prefix + "😀".repeat(400);
      const frames = await framesOf(chunk);
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) {
        expect(roundTrips(frame)).toBe(true);
        expect(bytes(frame)).toBeLessThanOrEqual(800);
      }
      expect(frames.join("")).toBe(chunk);
    }
  }, 120_000);

  test("limits two-byte text to 800 bytes a frame", async () => {
    const frames = await framesOf("é".repeat(1000));
    expect(frames.map((frame) => frame.length)).toEqual([400, 400, 200]);

    // 500 characters are fewer than 800 characters, but 1000 bytes are more than 800 bytes.
    const short = await framesOf("é".repeat(500));
    expect(short.map((frame) => frame.length)).toEqual([400, 100]);
  }, 120_000);

  test("keeps the whole chunk in the sidecar, whatever the frames are", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remember-frames-sidecar-"));
    dirs.push(dir);
    const chunk = "漢".repeat(1024);
    const index = join(dir, "t.json");
    await encodeChunks([chunk], join(dir, "t.mp4"), index);
    expect(loadSidecar(index)!.chunks.map((c) => c.text)).toEqual([chunk]);
  }, 120_000);
});
