import { afterEach, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSidecar } from "../src/remember/archive.ts";
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

  test("indexes a CJK text file at the default chunk_size", async () => {
    // The old frame size of 800 characters is 2400 bytes of CJK text, which is more than one QR frame holds (2331 bytes).
    const root = tmp();
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    const filePath = join(docs, "cjk.txt");
    writeFileSync(filePath, "漢".repeat(3000));
    const indexer = new FileIndexer({
      index_dir: join(root, "index"),
      allowed_roots: [docs],
    });

    const result = await indexer.indexFile({ file_path: filePath });
    expect(result.status).toBe("indexed");
    // 3000 characters at chunk_size 1024 give four chunks; every chunk is stored, so a search returns all four.
    expect(Number(result.chunk_count)).toBe(4);
    expect(Number(result.video_size)).toBeGreaterThan(0);
    expect(indexer.search({ query: "漢", top_k: 5 })).toHaveLength(4);
    indexer.close();
  }, 120_000);

  describe("chunk boundaries and surrogate pairs", () => {
    // `Buffer` turns a lone surrogate into U+FFFD, so a well-formed string is one that comes back unchanged.
    function wellFormed(text: string) {
      return Buffer.from(text, "utf8").toString("utf8") === text;
    }

    // A text of distinct astral code points: every chunk occurs once, so `indexOf` gives its start.
    function astral(count: number) {
      return Array.from({ length: count }, (_, i) => String.fromCodePoint(0x1f600 + i)).join("");
    }

    async function chunksOf(content: string, opts: { chunk_size?: number; overlap?: number } = {}) {
      const root = tmp();
      const docs = join(root, "docs");
      mkdirSync(docs, { recursive: true });
      const filePath = join(docs, "text.txt");
      writeFileSync(filePath, content);
      const indexDir = join(root, "index");
      const indexer = new FileIndexer({ index_dir: indexDir, allowed_roots: [docs] });
      try {
        const result = await indexer.indexFile({ file_path: filePath, ...opts });
        const sidecar = loadSidecar(join(indexDir, `${String(result.file_hash)}.json`));
        return sidecar!.chunks.map((chunk) => chunk.text);
      } finally {
        indexer.close();
      }
    }

    // The chunks of a text of distinct code points must start in order, leave no gap, and reach the end.
    function expectCoverage(content: string, chunks: string[], chunkSize: number) {
      let previousStart = -1;
      let reached = 0;
      for (const chunk of chunks) {
        const start = content.indexOf(chunk);
        expect(start).toBeGreaterThan(previousStart);
        expect(start).toBeLessThanOrEqual(reached);
        expect(chunk.length).toBeLessThanOrEqual(chunkSize);
        expect(wellFormed(chunk)).toBe(true);
        previousStart = start;
        reached = start + chunk.length;
      }
      expect(reached).toBe(content.length);
    }

    test("keeps an emoji whole when it crosses the end of a chunk", async () => {
      // The first cut falls at unit 1024, between the two units of the emoji at units 1023 and 1024.
      const content = "a".repeat(1023) + "\u{1F600}" + "b".repeat(2000);
      const chunks = await chunksOf(content);
      expect(chunks.every(wellFormed)).toBe(true);
      expect(chunks.every((chunk) => chunk.length <= 1024)).toBe(true);
      expect(chunks[0]).toBe("a".repeat(1023));
      expect(chunks.some((chunk) => chunk.includes("\u{1F600}"))).toBe(true);
    }, 120_000);

    test("starts the next chunk after the pair when the overlap lands inside it", async () => {
      // The first chunk ends at unit 64, so the next one would start at unit 56, between the two units of the emoji at units 55 and 56.
      const content = "a".repeat(55) + "\u{1F600}" + "b".repeat(300);
      const chunks = await chunksOf(content, { chunk_size: 64, overlap: 8 });
      expect(chunks.every(wellFormed)).toBe(true);
      expect(chunks[0]).toBe("a".repeat(55) + "\u{1F600}" + "b".repeat(7));
      expect(chunks[1]!.startsWith("b")).toBe(true);
    }, 120_000);

    test("keeps the pairs at both ends of the surrogate range whole", async () => {
      // U+10000 is the units D800 DC00 and U+10FFFF is the units DBFF DFFF. Each one sits across the first cut.
      for (const char of ["\u{10000}", "\u{10FFFF}"]) {
        const chunks = await chunksOf("a".repeat(1023) + char + "b".repeat(100));
        expect(chunks[0]).toBe("a".repeat(1023));
        expect(chunks.every(wellFormed)).toBe(true);
        expect(chunks.some((chunk) => chunk.includes(char))).toBe(true);
      }
    }, 120_000);

    test("covers a text of astral characters without a gap, whatever the sizes and the start parity", async () => {
      const cases = [
        { chunk_size: 101, overlap: 10, count: 600 },
        { chunk_size: 100, overlap: 9, count: 600 },
        { chunk_size: 33, overlap: 0, count: 600 },
        { chunk_size: 32, overlap: 1, count: 600 },
        // An overlap one below the size makes the next start fall back to start + 1, so each chunk adds one or two units.
        { chunk_size: 33, overlap: 32, count: 30 },
        { chunk_size: 32, overlap: 31, count: 30 },
      ];
      for (const prefix of ["", "x"]) {
        for (const { count, ...opts } of cases) {
          const content = prefix + astral(count);
          expectCoverage(content, await chunksOf(content, opts), opts.chunk_size);
        }
      }
    }, 120_000);

    test("keeps the chunk boundaries of a text without surrogates", async () => {
      // 3000 distinct BMP characters at the default chunk_size 1024 and overlap 128: starts 0, 896, 1792 and 2688.
      // The units before the first cuts sit at the edges of the surrogate range: U+D7FF before unit 896, U+FFFF before
      // unit 1024 and U+E000 before unit 1920. None of them is half of a pair, so no cut moves.
      const units = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(0x4e00 + i));
      units[895] = "\ud7ff";
      units[1023] = "\uffff";
      units[1919] = "\ue000";
      const content = units.join("");
      const chunks = await chunksOf(content);
      expect(chunks.map((chunk) => content.indexOf(chunk))).toEqual([0, 896, 1792, 2688]);
      expect(chunks.map((chunk) => chunk.length)).toEqual([1024, 1024, 1024, 312]);
    }, 120_000);
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
