import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndexer } from "../src/remember/file-indexer.ts";

describe("file indexing", () => {
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
    const d = mkdtempSync(join(tmpdir(), "remember-files-"));
    dirs.push(d);
    return d;
  }

  test("indexes a text file and finds it by search", async () => {
    const root = tmp();
    const indexDir = join(root, "index");
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    const filePath = join(docs, "notes.txt");
    writeFileSync(
      filePath,
      "The deploy runbook lives in the ops handbook and mentions blue-green releases.\n",
    );

    const indexer = new FileIndexer({
      index_dir: indexDir,
      allowed_roots: [docs],
    });

    const result = await indexer.indexFile({ file_path: filePath });
    expect(result.status).toBe("indexed");
    expect(Number(result.chunk_count)).toBeGreaterThan(0);

    const hits = indexer.search({ query: "blue-green deploy runbook", top_k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(String(hits[0]!.content)).toMatch(/runbook|blue-green/i);

    const listed = indexer.listIndexedFiles();
    expect(listed.length).toBe(1);
    expect(listed[0]!.file_path).toBe(filePath);

    const stats = indexer.getStats();
    expect(stats.total_files).toBe(1);
    indexer.close();
  }, 120_000);

  test("refuses paths outside allowed roots", async () => {
    const root = tmp();
    const indexer = new FileIndexer({
      index_dir: join(root, "index"),
      allowed_roots: [join(root, "allowed")],
    });
    mkdirSync(join(root, "allowed"), { recursive: true });
    const outside = join(root, "secret.txt");
    writeFileSync(outside, "nope");

    let threw = false;
    try {
      await indexer.indexFile({ file_path: outside });
    } catch (err) {
      threw = true;
      expect((err as Error).name).toBe("PermissionError");
    }
    expect(threw).toBe(true);
    indexer.close();
  });
});
