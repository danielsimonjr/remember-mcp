import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openToolSession, type ToolSession } from "./mcp-stdio.ts";

/**
 * Each test calls one tool through the stdio server and reads the JSON that the tool returns.
 * `tests/scheduler.test.ts` covers `scheduler_status` and `scheduler_control`, and
 * `tests/file-indexing.test.ts` covers the non-UTF-8 refusal of `index_file`.
 * The handler code checks its arguments after the SDK does, so the schema errors and the handler
 * errors are two different answers: a schema error has `isError: true` and a text message,
 * a handler error is a JSON object with `error` and `message` and `isError: false`.
 */

const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // the server may still hold the database for a moment
    }
  }
});

type Obj = Record<string, unknown>;

// An archive or an index run encodes a video with ffmpeg, which is slow on a CI runner.
const SLOW_MS = 120_000;
const slowTest = (name: string, fn: () => Promise<void>) => test(name, fn, SLOW_MS);

/** Call a tool, expect a result without an MCP error, and return its parsed JSON. */
async function callTool(session: ToolSession, name: string, args: Obj): Promise<unknown> {
  const r = await session.call(name, args);
  expect(r.isError).toBe(false);
  return r.value;
}

/** Expect a handler error with the `error` code, and a `message` that contains each text. */
function expectToolError(value: unknown, error: string, text: string, ...moreTexts: string[]): void {
  const r = value as Obj;
  expect(r.error).toBe(error);
  for (const t of [text, ...moreTexts]) {
    expect(String(r.message)).toContain(t);
  }
}

describe("memory tools over MCP", () => {
  let session: ToolSession;
  // Every test uses its own user_id, so the tests do not see each other's memories.
  let nextUser = 0;
  const user = () => `u${++nextUser}`;

  beforeAll(async () => {
    session = await openToolSession(tmp("remember-tools-"));
  }, 120_000);
  afterAll(async () => {
    await session?.close();
  });

  const call = (name: string, args: Obj) => callTool(session, name, args);

  describe("add_memory", () => {
    slowTest("returns the stored memory in active storage", async () => {
      const u = user();
      const m = (await call("add_memory", { content: "The deploy key rotates every 90 days", user_id: u })) as Obj;
      expect(typeof m.id).toBe("string");
      expect(m.content).toBe("The deploy key rotates every 90 days");
      expect(m.user_id).toBe(u);
      expect(m.location).toBe("active");
      expect(m.tags).toEqual([]);
      expect(typeof m.primary_sector).toBe("string");
      expect(m.sectors).toContain(m.primary_sector as string);
      expect(m.salience as number).toBeGreaterThan(0);
      expect(m.salience as number).toBeLessThanOrEqual(1);
    });

    slowTest("keeps the tags", async () => {
      const m = (await call("add_memory", { content: "tagged note", user_id: user(), tags: ["ops", "keys"] })) as Obj;
      expect(m.tags).toEqual(["ops", "keys"]);
    });

    slowTest("answers invalid_argument for an empty content, without an MCP error", async () => {
      expect(await call("add_memory", { content: "   " })).toEqual({
        error: "invalid_argument",
        message: "content must be a non-empty string",
      });
    });

    slowTest("answers invalid_argument for a content over the length limit", async () => {
      const r = await call("add_memory", { content: "x".repeat(100_001), user_id: user() });
      expectToolError(r, "invalid_argument", "content exceeds 100000 characters (100001 given)");
    });
  });

  describe("query_memory", () => {
    slowTest("finds an active memory and marks it as active", async () => {
      const u = user();
      await call("add_memory", { content: "The staging cluster restarts at midnight", user_id: u });
      const hits = (await call("query_memory", { query: "staging cluster restarts", user_id: u })) as Obj[];
      expect(hits).toHaveLength(1);
      expect(hits[0]!.content).toBe("The staging cluster restarts at midnight");
      expect(hits[0]!.location).toBe("active");
      expect(hits[0]!.archived_at).toBeNull();
      expect(hits[0]!.archive_file).toBeNull();
      expect(hits[0]!.score as number).toBeGreaterThan(0);
    });

    slowTest("returns only the memories of the user", async () => {
      const a = user();
      const b = user();
      await call("add_memory", { content: "Alice keeps the pager rota", user_id: a });
      expect(await call("query_memory", { query: "pager rota", user_id: b })).toEqual([]);
      expect(await call("query_memory", { query: "pager rota", user_id: a })).toHaveLength(1);
    });

    slowTest("returns at most `k` results, and ten when `k` is absent", async () => {
      const u = user();
      for (let i = 0; i < 11; i++) {
        await call("add_memory", { content: `capacity report number ${i} for the quarter`, user_id: u });
      }
      const limited = (await call("query_memory", { query: "capacity report", user_id: u, k: 3 })) as Obj[];
      expect(limited).toHaveLength(3);
      const byDefault = (await call("query_memory", { query: "capacity report", user_id: u })) as Obj[];
      expect(byDefault).toHaveLength(10);
    });

    slowTest("answers a list of one invalid_argument object for an empty query", async () => {
      expect(await call("query_memory", { query: "  " })).toEqual([
        { error: "invalid_argument", message: "query must be a non-empty string" },
      ]);
    });

    slowTest("returns only the memories of the sectors that `sectors` names", async () => {
      const u = user();
      const plain = (await call("add_memory", { content: "The deploy key rotates every 90 days", user_id: u })) as Obj;
      const happy = (await call("add_memory", { content: "Yesterday we were happy about the deploy", user_id: u })) as Obj;
      // The classifier gives the second memory the sector `emotional`, and the first memory not.
      expect(happy.sectors).toContain("emotional");
      expect(plain.sectors).not.toContain("emotional");

      expect(await call("query_memory", { query: "deploy", user_id: u })).toHaveLength(2);
      const hits = (await call("query_memory", { query: "deploy", user_id: u, sectors: ["emotional"] })) as Obj[];
      expect(hits.map((h) => h.id)).toEqual([happy.id]);
      expect(await call("query_memory", { query: "deploy", user_id: u, sectors: ["no-such-sector"] })).toEqual([]);
    });
  });

  describe("archive_memories", () => {
    // A pass selects a memory that is older than `age_days` AND has less salience than `min_salience`.
    // A new memory has a salience of 0.85, so one default is overridden in each call to test the other.
    slowTest("keeps a new memory under the default age, and under the default salience floor", async () => {
      const u = user();
      await call("add_memory", { content: "A fresh note about the lunch rota", user_id: u });
      const byAge = (await call("archive_memories", { min_salience: 1, user_id: u })) as Obj;
      expect(byAge.archived_count).toBe(0);
      expect(byAge.active_remaining).toBe(1);
      const bySalience = (await call("archive_memories", { age_days: 0, user_id: u })) as Obj;
      expect(bySalience.archived_count).toBe(0);
      expect(bySalience.active_remaining).toBe(1);
    });

    slowTest("moves the memory to an archive, and query_memory finds it there", async () => {
      const u = user();
      await call("add_memory", { content: "The vault token expires on the first of March", user_id: u });
      const r = (await call("archive_memories", { age_days: 0, min_salience: 1, user_id: u })) as Obj;
      expect(r.archived_count).toBe(1);
      expect(r.active_remaining).toBe(0);
      expect(r.archive_size_bytes as number).toBeGreaterThan(0);

      const hits = (await call("query_memory", { query: "vault token expires", user_id: u })) as Obj[];
      expect(hits).toHaveLength(1);
      expect(hits[0]!.content).toBe("The vault token expires on the first of March");
      expect(hits[0]!.location).toBe("archive");
      expect(String(hits[0]!.archive_file)).toMatch(new RegExp(`user_${u}_\\d+\\.mp4$`));
      expect(typeof hits[0]!.archived_at).toBe("number");
    });

    slowTest("query_memory skips the archives when `include_archive` is false", async () => {
      const u = user();
      await call("add_memory", { content: "The backup window opens at two in the morning", user_id: u });
      await call("archive_memories", { age_days: 0, min_salience: 1, user_id: u });
      expect(await call("query_memory", { query: "backup window", user_id: u, include_archive: false })).toEqual([]);
      expect(await call("query_memory", { query: "backup window", user_id: u })).toHaveLength(1);
    });

    slowTest("archives the memories of one user only", async () => {
      const a = user();
      const b = user();
      await call("add_memory", { content: "Alice owns the release checklist", user_id: a });
      await call("add_memory", { content: "Bob owns the release calendar", user_id: b });
      const r = (await call("archive_memories", { age_days: 0, min_salience: 1, user_id: a })) as Obj;
      expect(r.archived_count).toBe(1);
      const bHits = (await call("query_memory", { query: "release calendar", user_id: b })) as Obj[];
      expect(bHits).toHaveLength(1);
      expect(bHits[0]!.location).toBe("active");
    });

    slowTest("answers invalid_argument for a negative age", async () => {
      expect(await call("archive_memories", { age_days: -1, user_id: user() })).toEqual({
        error: "invalid_argument",
        message: "age_days must be >= 0",
      });
    });
  });

  describe("recall_memory", () => {
    async function archivedMemory(u: string, content: string): Promise<string> {
      await call("add_memory", { content, user_id: u });
      await call("archive_memories", { age_days: 0, min_salience: 1, user_id: u });
      const hits = (await call("query_memory", { query: content, user_id: u })) as Obj[];
      return String(hits[0]!.archive_file);
    }

    slowTest("adds the content to active storage when the archive file is the one that query_memory returned", async () => {
      const u = user();
      const file = await archivedMemory(u, "The escalation phone number is on the wiki");
      const m = (await call("recall_memory", {
        archive_file: file,
        content: "The escalation phone number is on the wiki",
        user_id: u,
      })) as Obj;
      expect(m.location).toBe("active");
      expect(m.user_id).toBe(u);
      expect(m.content).toBe("The escalation phone number is on the wiki");

      const hits = (await call("query_memory", { query: "escalation phone number", user_id: u })) as Obj[];
      expect(hits.map((h) => h.location).sort()).toEqual(["active", "archive"]);
    });

    slowTest("accepts the archive name without the `.mp4` extension", async () => {
      const u = user();
      const file = await archivedMemory(u, "The canary deploy goes out on Tuesdays");
      const m = (await call("recall_memory", {
        archive_file: file.replace(/\.mp4$/, ""),
        content: "The canary deploy goes out on Tuesdays",
        user_id: u,
      })) as Obj;
      expect(m.location).toBe("active");
    });

    slowTest("answers not_found for an archive that does not exist", async () => {
      const r = await call("recall_memory", {
        archive_file: "mcp_archives/user_nobody_1.mp4",
        content: "anything",
        user_id: user(),
      });
      expectToolError(r, "not_found", "Unknown archive: mcp_archives/user_nobody_1.mp4");
    });

    slowTest("answers not_found when another user asks for the archive", async () => {
      const owner = user();
      const file = await archivedMemory(owner, "The owner archived this note on purpose");
      const r = await call("recall_memory", { archive_file: file, content: "stolen", user_id: user() });
      expectToolError(r, "not_found", "Unknown archive");
    });

    slowTest("answers invalid_argument for an empty content", async () => {
      const u = user();
      const file = await archivedMemory(u, "A note whose recall will be empty");
      expect(await call("recall_memory", { archive_file: file, content: "", user_id: u })).toEqual({
        error: "invalid_argument",
        message: "content must be a non-empty string",
      });
    });
  });

  describe("get_stats", () => {
    slowTest("counts the active and the archived memories of a user", async () => {
      const u = user();
      await call("add_memory", { content: "First statistic note", user_id: u });
      await call("add_memory", { content: "Second statistic note", user_id: u });
      const before = (await call("get_stats", { user_id: u })) as Obj;
      expect(before.active_count).toBe(2);
      expect(before.archive_count).toBe(0);
      expect(before.archive_file_count).toBe(0);
      expect(before.total_memories).toBe(2);

      await call("archive_memories", { age_days: 0, min_salience: 1, user_id: u });
      await call("add_memory", { content: "Third statistic note", user_id: u });
      const after = (await call("get_stats", { user_id: u })) as Obj;
      expect(after.active_count).toBe(1);
      expect(after.archive_count).toBe(2);
      expect(after.archive_file_count).toBe(1);
      expect(after.total_memories).toBe(3);
      expect(after.archive_size as number).toBeGreaterThan(0);
      expect(after.total_size).toBe((after.active_db_size as number) + (after.archive_size as number));
    });

    slowTest("scopes the counts to the user, and adds the users up without a user", async () => {
      const a = user();
      const b = user();
      const before = (await call("get_stats", {})) as Obj;
      await call("add_memory", { content: "Alice scoped note", user_id: a });
      await call("add_memory", { content: "Bob scoped note one", user_id: b });
      await call("add_memory", { content: "Bob scoped note two", user_id: b });
      expect(((await call("get_stats", { user_id: a })) as Obj).active_count).toBe(1);
      expect(((await call("get_stats", { user_id: b })) as Obj).active_count).toBe(2);
      const everyone = (await call("get_stats", {})) as Obj;
      expect(everyone.active_count).toBe((before.active_count as number) + 3);
    });
  });
});

describe("file tools over MCP", () => {
  let session: ToolSession;
  let cwd: string;
  let docs: string;

  const doc = (name: string) => join(docs, name);

  beforeAll(async () => {
    cwd = tmp("remember-filetools-");
    docs = join(cwd, "docs");
    mkdirSync(join(docs, "nested-docs"), { recursive: true });
    writeFileSync(doc("runbook.txt"), "The deploy runbook lives in the ops handbook and mentions blue-green releases.\n");
    writeFileSync(doc("retention.md"), "# Retention\nBackups are kept for ninety days before pruning.\n");
    writeFileSync(join(docs, "nested-docs", "rotation.txt"), "Rotation of the signing key happens every quarter.\n");
    writeFileSync(doc(".secret.txt"), "dotfile body\n");
    // `REMEMBER_INDEX_ROOTS` confines the indexer to `docs`, so `cwd` itself is outside the roots.
    session = await openToolSession(cwd, { REMEMBER_INDEX_ROOTS: docs });
  }, 120_000);
  afterAll(async () => {
    await session?.close();
  });

  const call = (name: string, args: Obj) => callTool(session, name, args);

  // The tests run in file order: the first ones fill the index and the later ones read it.
  slowTest("get_file_stats and list_indexed_files are empty before anything is indexed", async () => {
    expect(await call("get_file_stats", {})).toEqual({
      total_files: 0,
      total_chunks: 0,
      total_source_size: 0,
      total_video_size: 0,
      compression_ratio: 0,
      file_types: {},
    });
    expect(await call("list_indexed_files", {})).toEqual([]);
  });

  slowTest("index_file indexes a file, and answers already_indexed for the same content", async () => {
    const first = (await call("index_file", { file_path: doc("runbook.txt") })) as Obj;
    expect(first.status).toBe("indexed");
    expect(first.file_path).toBe(doc("runbook.txt"));
    expect(first.file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.chunk_count).toBe(1);
    expect(first.video_size as number).toBeGreaterThan(0);

    const again = (await call("index_file", { file_path: doc("runbook.txt") })) as Obj;
    expect(again.status).toBe("already_indexed");
    expect(again.file_hash).toBe(first.file_hash);
    expect(typeof again.indexed_at).toBe("string");
  });

  slowTest("index_file refuses a dotfile unless `index_dotfiles` is true", async () => {
    const refused = await call("index_file", { file_path: doc(".secret.txt") });
    expectToolError(refused, "permission_denied", "Refusing to index dotfile");

    const allowed = (await call("index_file", { file_path: doc(".secret.txt"), index_dotfiles: true })) as Obj;
    expect(allowed.status).toBe("indexed");
  });

  slowTest("index_file answers not_found for a missing file", async () => {
    const r = await call("index_file", { file_path: doc("missing.txt") });
    expectToolError(r, "not_found", "File not found");
  });

  slowTest("index_file and index_directory answer permission_denied for a path outside the roots", async () => {
    const file = join(cwd, "outside.txt");
    writeFileSync(file, "outside the roots\n");
    for (const [tool, args] of [
      ["index_file", { file_path: file }],
      ["index_directory", { dir_path: cwd }],
    ] as const) {
      const r = await call(tool, args);
      expectToolError(r, "permission_denied", "outside allowed roots", "REMEMBER_INDEX_ROOTS");
    }
  });

  slowTest("index_directory indexes the matching files, and the later pattern run reports already_indexed", async () => {
    const all = (await call("index_directory", { dir_path: docs })) as Obj;
    // `.secret.txt` is already indexed, but a directory run skips dotfiles, so three files are left.
    expect(all.indexed_count).toBe(3);
    expect(all.error_count).toBe(0);
    expect(all.errors).toEqual([]);
    const names = (all.indexed_files as Obj[]).map((f) => String(f.file_path).replace(docs, "").replace(/\\/g, "/"));
    expect(names.sort()).toEqual(["/nested-docs/rotation.txt", "/retention.md", "/runbook.txt"]);

    const onlyMarkdown = (await call("index_directory", { dir_path: docs, pattern: "*.md" })) as Obj;
    expect(onlyMarkdown.indexed_count).toBe(1);
    const files = onlyMarkdown.indexed_files as Obj[];
    expect(files).toHaveLength(1);
    expect(files[0]!.status).toBe("already_indexed");
    expect(files[0]!.file_path).toBe(doc("retention.md"));
  });

  slowTest("list_indexed_files lists each indexed file with its type and size", async () => {
    const listed = (await call("list_indexed_files", {})) as Obj[];
    const byName = new Map(listed.map((f) => [String(f.file_name), f]));
    expect([...byName.keys()].sort()).toEqual([".secret.txt", "retention.md", "rotation.txt", "runbook.txt"]);
    expect(byName.get("retention.md")!.file_type).toBe("markdown");
    expect(byName.get("runbook.txt")!.file_type).toBe("text");
    expect(byName.get("runbook.txt")!.file_size).toBe(79);
    expect(byName.get("runbook.txt")!.chunk_count).toBe(1);
  });

  slowTest("get_file_info returns the metadata of an indexed file, and null for a path that was never indexed", async () => {
    const info = (await call("get_file_info", { file_path: doc("runbook.txt") })) as Obj;
    expect(info.file_path).toBe(doc("runbook.txt"));
    expect(info.file_name).toBe("runbook.txt");
    expect(info.file_type).toBe("text");
    expect(info.file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(info.chunk_count).toBe(1);
    expect((info.stats as Obj).chunk_count).toBe(1);
    expect(await call("get_file_info", { file_path: doc("never-indexed.txt") })).toBeNull();
  });

  slowTest("get_file_stats counts the files, the chunks and the types", async () => {
    const stats = (await call("get_file_stats", {})) as Obj;
    expect(stats.total_files).toBe(4);
    expect(stats.total_chunks).toBe(4);
    expect(stats.file_types).toEqual({ text: 3, markdown: 1 });
    expect(stats.total_source_size as number).toBeGreaterThan(0);
    expect(stats.total_video_size as number).toBeGreaterThan(0);
  });

  slowTest("search_files orders the hits by score, and limits them to `top_k`", async () => {
    // `runbook.txt` was indexed first, so a search that skips its sort would put it first.
    const best = (await call("search_files", { query: "signing key rotation quarter", top_k: 1 })) as Obj[];
    expect(best).toHaveLength(1);
    expect(best[0]!.file_name).toBe("rotation.txt");
    expect(String(best[0]!.content)).toContain("signing key");
    expect(best[0]!.score as number).toBeGreaterThan(0);

    // Every indexed chunk is a hit when `top_k` is absent, because the default is above the 4 chunks.
    const all = (await call("search_files", { query: "backups ninety days" })) as Obj[];
    expect(all).toHaveLength(4);
    expect(all[0]!.file_name).toBe("retention.md");
    const scores = all.map((h) => h.score as number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  slowTest("search_files keeps the files whose path contains `file_filter`", async () => {
    const hits = (await call("search_files", { query: "signing key", file_filter: "nested-docs" })) as Obj[];
    expect(hits.map((h) => h.file_name)).toEqual(["rotation.txt"]);
    expect(await call("search_files", { query: "signing key", file_filter: "no-such-folder" })).toEqual([]);
  });

  slowTest("search_files keeps one file type with `file_type_filter`", async () => {
    const markdown = (await call("search_files", { query: "backups ninety days", file_type_filter: "markdown" })) as Obj[];
    expect(markdown.length).toBeGreaterThan(0);
    expect(new Set(markdown.map((h) => h.file_type))).toEqual(new Set(["markdown"]));
    const text = (await call("search_files", { query: "backups ninety days", file_type_filter: "text" })) as Obj[];
    expect(text.map((h) => h.file_name)).not.toContain("retention.md");
  });

  slowTest("search_files answers a list of one invalid_argument object for an empty query", async () => {
    expect(await call("search_files", { query: "" })).toEqual([
      { error: "invalid_argument", message: "query must be a non-empty string" },
    ]);
  });
});

describe("optional arguments of the file tools over MCP", () => {
  let session: ToolSession;
  let docs: string;

  const doc = (...parts: string[]) => join(docs, ...parts);
  const call = (name: string, args: Obj) => callTool(session, name, args);

  beforeAll(async () => {
    const cwd = tmp("remember-fileargs-");
    docs = join(cwd, "docs");
    mkdirSync(join(docs, "batch", "keep"), { recursive: true });
    mkdirSync(join(docs, "batch", "skipme"), { recursive: true });
    // A code file of 30 lines. The default chunk size gives the chunks of the lines 1-20 and 21-30.
    const code = Array.from({ length: 30 }, (_, i) => (i < 20 ? `const alpha = ${i + 1};` : `const omega = ${i + 1};`));
    writeFileSync(doc("by-lines.ts"), code.join("\n"));
    writeFileSync(doc("whole.ts"), code.join("\n") + "\n// a second copy\n");
    // 20 sentences of 32 characters. The files differ in their last word, so the hashes differ.
    const text = "alpha beta gamma delta epsilon. ".repeat(20);
    writeFileSync(doc("small-chunks.txt"), text);
    writeFileSync(doc("default-chunks.txt"), text + "tail");
    writeFileSync(doc("batch", "keep", "kept.txt"), text + "kept");
    writeFileSync(doc("batch", "skipme", "skipped.txt"), "a skipped file about gardening\n");
    writeFileSync(doc(".hidden.txt"), "a hidden file about gardening\n");
    session = await openToolSession(cwd, { REMEMBER_INDEX_ROOTS: docs });
  }, 120_000);
  afterAll(async () => {
    await session?.close();
  });

  // The tests run in file order, and no test reads a file that an earlier test did not index.
  slowTest("index_file splits a code file by lines, unless `preserve_lines` is false", async () => {
    const split = (await call("index_file", { file_path: doc("by-lines.ts") })) as Obj;
    expect(split.chunk_count).toBe(2);
    const late = (await call("search_files", { query: "omega", file_filter: "by-lines.ts", top_k: 1 })) as Obj[];
    expect(String(late[0]!.content).startsWith("[by-lines.ts:21-30]\n")).toBe(true);
    expect(late[0]!.line_info).toBe("[by-lines.ts:21-30]");

    const whole = (await call("index_file", { file_path: doc("whole.ts"), preserve_lines: false })) as Obj;
    expect(whole.chunk_count).toBe(1);
    const hit = (await call("search_files", { query: "omega", file_filter: "whole.ts", top_k: 1 })) as Obj[];
    expect(String(hit[0]!.content).startsWith("const alpha = 1;")).toBe(true);
    expect(hit[0]!.line_info ?? null).toBeNull();
  });

  slowTest("index_file stores the `chunk_size` and the `overlap` that it was given, and the defaults otherwise", async () => {
    const small = (await call("index_file", { file_path: doc("small-chunks.txt"), chunk_size: 64, overlap: 0 })) as Obj;
    expect(small.chunk_count).toBe(10);
    const smallInfo = (await call("get_file_info", { file_path: doc("small-chunks.txt") })) as Obj;
    expect(smallInfo.chunk_size).toBe(64);
    expect(smallInfo.overlap).toBe(0);

    const byDefault = (await call("index_file", { file_path: doc("default-chunks.txt") })) as Obj;
    expect(byDefault.chunk_count).toBe(1);
    const defaultInfo = (await call("get_file_info", { file_path: doc("default-chunks.txt") })) as Obj;
    expect(defaultInfo.chunk_size).toBe(1024);
    expect(defaultInfo.overlap).toBe(128);
  });

  slowTest("index_directory skips the paths that `exclude` names, and passes `chunk_size` and `overlap` on", async () => {
    const r = (await call("index_directory", {
      dir_path: doc("batch"),
      exclude: ["skipme"],
      chunk_size: 64,
      overlap: 0,
    })) as Obj;
    expect(r.indexed_count).toBe(1);
    expect(r.skipped_count).toBe(1);
    const kept = (await call("get_file_info", { file_path: doc("batch", "keep", "kept.txt") })) as Obj;
    expect(kept.chunk_size).toBe(64);
    expect(kept.overlap).toBe(0);
    expect(await call("get_file_info", { file_path: doc("batch", "skipme", "skipped.txt") })).toBeNull();
  });

  // A glob scan never returns a dotfile unless the pattern names it, so the pattern names this one.
  slowTest("index_directory skips a dotfile that its pattern names, unless `index_dotfiles` is true", async () => {
    const refused = (await call("index_directory", { dir_path: docs, pattern: ".hidden.txt" })) as Obj;
    expect(refused.indexed_count).toBe(0);
    expect(refused.skipped_count).toBe(1);
    expect(await call("get_file_info", { file_path: doc(".hidden.txt") })).toBeNull();

    const allowed = (await call("index_directory", { dir_path: docs, pattern: ".hidden.txt", index_dotfiles: true })) as Obj;
    expect(allowed.indexed_count).toBe(1);
    expect(await call("get_file_info", { file_path: doc(".hidden.txt") })).not.toBeNull();
  });
});

describe("errors that the SDK raises before a handler runs", () => {
  let session: ToolSession;

  beforeAll(async () => {
    session = await openToolSession(tmp("remember-schema-"));
  }, 120_000);
  afterAll(async () => {
    await session?.close();
  });

  test("an unknown tool is a JSON-RPC error with code -32602", async () => {
    const response = await session.request("tools/call", { name: "no_such_tool", arguments: {} });
    expect(response!.result).toBeUndefined();
    expect(response!.error).toEqual({ code: -32602, message: "Tool no_such_tool not found" });
  });

  test.each([
    ["add_memory", { content: "x", extra: 1 }, "must NOT have additional properties"],
    ["add_memory", {}, "must have required property 'content'"],
    ["query_memory", { query: "x", k: 1000 }, "data/k must be <= 100"],
    ["query_memory", { query: "x", k: 0 }, "data/k must be >= 1"],
    ["query_memory", { query: "x", k: 2.5 }, "data/k must be integer"],
    ["recall_memory", { archive_file: "a" }, "must have required property 'content'"],
    ["scheduler_control", { action: "bogus" }, "must be equal to one of the allowed values"],
    ["index_file", {}, "must have required property 'file_path'"],
  ] as const)("%s %j is refused with isError and a text message", async (name, args, text) => {
    const r = await session.call(name, args);
    expect(r.isError).toBe(true);
    expect(String(r.value)).toContain(`Input validation error: Invalid arguments for tool ${name}`);
    expect(String(r.value)).toContain(text);
  });
});
