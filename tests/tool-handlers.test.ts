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

describe("memory tools over MCP", () => {
  let session: ToolSession;
  // Every test uses its own user_id, so the tests do not see each other's memories.
  let nextUser = 0;
  const user = () => `u${++nextUser}`;

  beforeAll(async () => {
    session = await openToolSession(tmp("remember-tools-"));
  }, 120_000);
  afterAll(async () => {
    await session.close();
  });

  const call = async (name: string, args: Obj) => {
    const r = await session.call(name, args);
    expect(r.isError).toBe(false);
    return r.value;
  };

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
      const r = (await call("add_memory", { content: "x".repeat(100_001), user_id: user() })) as Obj;
      expect(r.error).toBe("invalid_argument");
      expect(String(r.message)).toContain("content exceeds 100000 characters (100001 given)");
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
      expect(((await call("query_memory", { query: "pager rota", user_id: a })) as Obj[]).length).toBe(1);
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
  });

  describe("archive_memories", () => {
    slowTest("archives nothing from a memory that is newer than the default age", async () => {
      const u = user();
      await call("add_memory", { content: "A fresh note about the lunch rota", user_id: u });
      const r = (await call("archive_memories", { user_id: u })) as Obj;
      expect(r.archived_count).toBe(0);
      expect(r.active_remaining).toBe(1);
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
      expect(((await call("query_memory", { query: "backup window", user_id: u })) as Obj[]).length).toBe(1);
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
      const r = (await call("recall_memory", {
        archive_file: "mcp_archives/user_nobody_1.mp4",
        content: "anything",
        user_id: user(),
      })) as Obj;
      expect(r.error).toBe("not_found");
      expect(String(r.message)).toContain("Unknown archive: mcp_archives/user_nobody_1.mp4");
    });

    slowTest("answers not_found when another user asks for the archive", async () => {
      const owner = user();
      const file = await archivedMemory(owner, "The owner archived this note on purpose");
      const r = (await call("recall_memory", { archive_file: file, content: "stolen", user_id: user() })) as Obj;
      expect(r.error).toBe("not_found");
      expect(String(r.message)).toContain("Unknown archive");
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
      expect(after.total_size as number).toBeGreaterThanOrEqual(after.archive_size as number);
    });

    slowTest("scopes the counts to the user, and adds the users up without a user", async () => {
      const a = user();
      const b = user();
      await call("add_memory", { content: "Alice scoped note", user_id: a });
      await call("add_memory", { content: "Bob scoped note one", user_id: b });
      await call("add_memory", { content: "Bob scoped note two", user_id: b });
      expect(((await call("get_stats", { user_id: a })) as Obj).active_count).toBe(1);
      expect(((await call("get_stats", { user_id: b })) as Obj).active_count).toBe(2);
      const everyone = (await call("get_stats", {})) as Obj;
      expect(everyone.active_count as number).toBeGreaterThanOrEqual(3);
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
    mkdirSync(join(docs, "sub"), { recursive: true });
    writeFileSync(doc("runbook.txt"), "The deploy runbook lives in the ops handbook and mentions blue-green releases.\n");
    writeFileSync(doc("retention.md"), "# Retention\nBackups are kept for ninety days before pruning.\n");
    writeFileSync(join(docs, "sub", "rotation.txt"), "Rotation of the signing key happens every quarter.\n");
    writeFileSync(doc(".secret.txt"), "dotfile body\n");
    // `REMEMBER_INDEX_ROOTS` confines the indexer to `docs`, so `cwd` itself is outside the roots.
    session = await openToolSession(cwd, { REMEMBER_INDEX_ROOTS: docs });
  });
  afterAll(async () => {
    await session.close();
  });

  const call = async (name: string, args: Obj) => {
    const r = await session.call(name, args);
    expect(r.isError).toBe(false);
    return r.value;
  };

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
    const refused = (await call("index_file", { file_path: doc(".secret.txt") })) as Obj;
    expect(refused.error).toBe("permission_denied");
    expect(String(refused.message)).toContain("Refusing to index dotfile");

    const allowed = (await call("index_file", { file_path: doc(".secret.txt"), index_dotfiles: true })) as Obj;
    expect(allowed.status).toBe("indexed");
  });

  slowTest("index_file answers not_found for a missing file", async () => {
    const r = (await call("index_file", { file_path: doc("missing.txt") })) as Obj;
    expect(r.error).toBe("not_found");
    expect(String(r.message)).toContain("File not found");
  });

  slowTest("index_file and index_directory answer permission_denied for a path outside the roots", async () => {
    const file = join(cwd, "outside.txt");
    writeFileSync(file, "outside the roots\n");
    for (const [tool, args] of [
      ["index_file", { file_path: file }],
      ["index_directory", { dir_path: cwd }],
    ] as const) {
      const r = (await call(tool, args)) as Obj;
      expect(r.error).toBe("permission_denied");
      expect(String(r.message)).toContain("outside allowed roots");
      expect(String(r.message)).toContain("REMEMBER_INDEX_ROOTS");
    }
  });

  slowTest("index_directory indexes the matching files, and the later pattern run reports already_indexed", async () => {
    const all = (await call("index_directory", { dir_path: docs })) as Obj;
    // `.secret.txt` is already indexed, but a directory run skips dotfiles, so three files are left.
    expect(all.indexed_count).toBe(3);
    expect(all.error_count).toBe(0);
    expect(all.errors).toEqual([]);
    const names = (all.indexed_files as Obj[]).map((f) => String(f.file_path).replace(docs, "").replace(/\\/g, "/"));
    expect(names.sort()).toEqual(["/retention.md", "/runbook.txt", "/sub/rotation.txt"]);

    const onlyMarkdown = (await call("index_directory", { dir_path: docs, pattern: "*.md" })) as Obj;
    expect(onlyMarkdown.indexed_count).toBe(1);
    const files = onlyMarkdown.indexed_files as Obj[];
    expect(files).toHaveLength(1);
    expect(files[0]!.status).toBe("already_indexed");
    expect(String(files[0]!.file_path)).toBe(doc("retention.md"));
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

  slowTest("get_file_info returns the metadata of an indexed file, and null for any other file", async () => {
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

  slowTest("search_files returns the best chunk first and limits the hits to `top_k`", async () => {
    const hits = (await call("search_files", { query: "blue-green deploy runbook", top_k: 1 })) as Obj[];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file_name).toBe("runbook.txt");
    expect(String(hits[0]!.content)).toContain("blue-green");
    expect(hits[0]!.score as number).toBeGreaterThan(0);
  });

  slowTest("search_files keeps the files whose path contains `file_filter`", async () => {
    const hits = (await call("search_files", { query: "signing key", file_filter: "sub" })) as Obj[];
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

describe("errors that the SDK raises before a handler runs", () => {
  let session: ToolSession;

  beforeAll(async () => {
    session = await openToolSession(tmp("remember-schema-"));
  }, 120_000);
  afterAll(async () => {
    await session.close();
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
