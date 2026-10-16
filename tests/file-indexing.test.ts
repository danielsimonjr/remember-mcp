import { afterEach, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndexer } from "../src/remember/file-indexer.ts";
import { sendJsonRpc, spawnServer } from "./mcp-stdio.ts";

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

  describe("line_info on search hits", () => {
    // A code file of 30 lines. The default chunk_size 1024 gives 20 lines per chunk, so the
    // chunks are lines 1-20 and lines 21-30. The first 20 lines carry the token alpha, the
    // last 10 carry the token omega, so a query for one token ranks its own chunk first.
    function writeCodeFile(docs: string): string {
      const lines: string[] = [];
      for (let i = 1; i <= 30; i++) {
        lines.push(i <= 20 ? `const alpha = ${i};` : `const omega = ${i};`);
      }
      const filePath = join(docs, "sample.ts");
      writeFileSync(filePath, lines.join("\n"));
      return filePath;
    }

    function setup() {
      const root = tmp();
      const docs = join(root, "docs");
      mkdirSync(docs, { recursive: true });
      const indexer = new FileIndexer({
        index_dir: join(root, "index"),
        allowed_roots: [docs],
      });
      return { docs, indexer };
    }

    test("a code chunk carries the line range of its header", async () => {
      const { docs, indexer } = setup();
      await indexer.indexFile({ file_path: writeCodeFile(docs) });

      const late = indexer.search({ query: "omega", top_k: 5 });
      expect(String(late[0]!.content).startsWith("[sample.ts:21-30]\n")).toBe(true);
      expect(late[0]!.line_info).toBe("[sample.ts:21-30]");

      const early = indexer.search({ query: "alpha", top_k: 5 });
      expect(String(early[0]!.content).startsWith("[sample.ts:1-20]\n")).toBe(true);
      expect(early[0]!.line_info).toBe("[sample.ts:1-20]");
      indexer.close();
    }, 120_000);

    test("a text chunk that starts with a link reference has no line_info", async () => {
      const { docs, indexer } = setup();
      const filePath = join(docs, "refs.md");
      writeFileSync(filePath, "[1]: https://example.com/changelog about the changelog page\n");
      await indexer.indexFile({ file_path: filePath });

      const hits = indexer.search({ query: "changelog", top_k: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(String(hits[0]!.content).startsWith("[1]:")).toBe(true);
      expect(hits[0]!.line_info).toBeUndefined();
      indexer.close();
    }, 120_000);

    test("a file indexed without line chunks has no line_info, even for a header-shaped first line", async () => {
      const { docs, indexer } = setup();
      const filePath = join(docs, "notes.ts");
      writeFileSync(filePath, "[notes.ts:1-5]\nconst omega = 1;\n");
      await indexer.indexFile({ file_path: filePath, preserve_lines: false });

      const hits = indexer.search({ query: "omega", top_k: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(String(hits[0]!.content).startsWith("[notes.ts:1-5]\n")).toBe(true);
      expect(hits[0]!.line_info).toBeUndefined();
      indexer.close();
    }, 120_000);
  });

  describe("a file that is not valid UTF-8", () => {
    function setup() {
      const root = tmp();
      const docs = join(root, "docs");
      mkdirSync(docs, { recursive: true });
      const indexer = new FileIndexer({
        index_dir: join(root, "index"),
        allowed_roots: [docs],
      });
      return { docs, indexer };
    }

    async function refusal(indexer: FileIndexer, filePath: string): Promise<Error | undefined> {
      try {
        await indexer.indexFile({ file_path: filePath });
      } catch (err) {
        return err as Error;
      }
      return undefined;
    }

    test("a Latin-1 file is refused with a clear message and nothing is recorded", async () => {
      const { docs, indexer } = setup();
      const filePath = join(docs, "latin1.txt");
      // "cafe ok" with the Latin-1 byte 0xE9 for the last letter of "cafe". The byte is not valid
      // UTF-8, and the file has no zero byte, so the binary check does not refuse it first.
      writeFileSync(filePath, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]));

      const err = await refusal(indexer, filePath);
      expect(err).toBeDefined();
      expect(err!.name).toBe("PermissionError");
      expect(err!.message).toContain("Refusing to index non-UTF-8 file:");
      expect(err!.message).toContain("latin1.txt");
      expect(indexer.listIndexedFiles().length).toBe(0);
      indexer.close();
    }, 120_000);

    test("an invalid continuation byte is refused", async () => {
      const { docs, indexer } = setup();
      const filePath = join(docs, "broken.txt");
      writeFileSync(filePath, Buffer.from([0x61, 0x62, 0xc3, 0x28, 0x63]));

      const err = await refusal(indexer, filePath);
      expect(err).toBeDefined();
      expect(err!.name).toBe("PermissionError");
      expect(indexer.listIndexedFiles().length).toBe(0);
      indexer.close();
    }, 120_000);

    test("a valid UTF-8 file with non-ASCII text is still indexed", async () => {
      const { docs, indexer } = setup();
      const filePath = join(docs, "cafe.txt");
      writeFileSync(filePath, "caf\u00e9 \u2615 and na\u00efve plans for the quarterly review\n", "utf8");

      const result = await indexer.indexFile({ file_path: filePath });
      expect(result.status).toBe("indexed");
      const hits = indexer.search({ query: "quarterly review plans", top_k: 3 });
      expect(hits.length).toBeGreaterThan(0);
      expect(String(hits[0]!.content)).toContain("caf\u00e9");
      indexer.close();
    }, 120_000);

    test("a valid UTF-8 file that starts with a byte order mark decodes as before", async () => {
      const { docs, indexer } = setup();
      const filePath = join(docs, "bom.txt");
      writeFileSync(
        filePath,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("plain text after a byte order mark\n")]),
      );

      const result = await indexer.indexFile({ file_path: filePath });
      expect(result.status).toBe("indexed");
      // `Buffer.toString` kept the mark in the text, and the strict decoder must keep it too.
      const hits = indexer.search({ query: "plain text byte order mark", top_k: 1 });
      expect(String(hits[0]!.content).startsWith("\ufeff")).toBe(true);
      indexer.close();
    }, 120_000);

    test("a directory run records the refused file as an error and indexes the others", async () => {
      const { docs, indexer } = setup();
      writeFileSync(join(docs, "good.txt"), "a plain ASCII file about the retention policy\n");
      writeFileSync(join(docs, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]));

      const result = await indexer.indexDirectory({ dir_path: docs });
      expect(result.indexed_count).toBe(1);
      expect(result.error_count).toBe(1);
      const errors = result.errors as Array<{ file: string; error: string }>;
      expect(errors[0]!.file).toContain("latin1.txt");
      expect(errors[0]!.error).toContain("Refusing to index non-UTF-8 file:");
      indexer.close();
    }, 120_000);
  });

  describe("index_file over MCP", () => {
    test("a Latin-1 file answers permission_denied, and a valid file is still indexed", async () => {
      const cwd = tmp();
      const docs = join(cwd, "docs");
      mkdirSync(docs, { recursive: true });
      const latin1 = join(docs, "latin1.txt");
      writeFileSync(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]));
      const valid = join(docs, "valid.txt");
      writeFileSync(valid, "a plain ASCII file about the retention policy\n");

      // `spawnServer` copies the environment of this process, so the roots variable is set for the spawn only.
      const previousRoots = process.env.REMEMBER_INDEX_ROOTS;
      process.env.REMEMBER_INDEX_ROOTS = docs;
      const server = spawnServer(cwd);
      if (previousRoots === undefined) delete process.env.REMEMBER_INDEX_ROOTS;
      else process.env.REMEMBER_INDEX_ROOTS = previousRoots;

      try {
        await sendJsonRpc(server, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "remember-mcp-test", version: "0.0.1" },
          },
        });
        server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        await server.stdin.flush();

        let id = 1;
        const call = async (name: string, args: Record<string, unknown>) => {
          const response = await sendJsonRpc(server, {
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: args },
          });
          expect(response).not.toBeNull();
          const result = response!.result as { isError?: boolean; content: { text: string }[] };
          if (result.isError) throw new Error(result.content[0]!.text);
          return JSON.parse(result.content[0]!.text) as unknown;
        };

        const refused = (await call("index_file", { file_path: latin1 })) as Record<string, unknown>;
        expect(refused.error).toBe("permission_denied");
        expect(String(refused.message)).toContain("Refusing to index non-UTF-8 file:");
        expect(String(refused.message)).toContain("latin1.txt");

        const accepted = (await call("index_file", { file_path: valid })) as Record<string, unknown>;
        expect(accepted.status).toBe("indexed");

        const listed = (await call("list_indexed_files", {})) as Array<Record<string, unknown>>;
        expect(listed.map((f) => f.file_name)).toEqual(["valid.txt"]);
      } finally {
        server.proc.kill();
        await server.proc.exited;
      }
    }, 120_000);
  });
});
