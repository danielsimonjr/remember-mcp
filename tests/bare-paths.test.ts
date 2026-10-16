import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, spawnServer, sendJsonRpc } from "./mcp-stdio.ts";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

/**
 * A bare file name has `.` as its directory, and `..` and `.` name a directory that always exists.
 * Bun on Windows throws EEXIST for `mkdirSync(".", { recursive: true })`; Bun on Linux does not.
 * Each test runs the code in a child process whose working directory is a new empty folder.
 */
describe("bare and relative paths", () => {
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
    const d = mkdtempSync(join(tmpdir(), "remember-bare-"));
    dirs.push(d);
    return d;
  }

  /** Run `body` (async code) in a child process with the working directory `cwd`. */
  function inChild(cwd: string, body: string) {
    const r = Bun.spawnSync([process.execPath, "-e", body], {
      cwd,
      env: { ...process.env, REPO },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  }

  const load = (file: string) =>
    `const m = await import(require("node:url").pathToFileURL(process.env.REPO + "/src/remember/${file}").href);`;

  test("ActiveStore opens a database that has a bare file name", () => {
    const cwd = tmp();
    const r = inChild(cwd, `${load("active-store.ts")} new m.ActiveStore("remember_mcp.db").db.close();`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "remember_mcp.db"))).toBe(true);
  });

  test("ActiveStore still creates the folders of a nested database path", () => {
    const cwd = tmp();
    const r = inChild(cwd, `${load("active-store.ts")} new m.ActiveStore("a/b/store.db").db.close();`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "a", "b", "store.db"))).toBe(true);
  });

  test("RememberSystem accepts the current folder as its archive folder", () => {
    const cwd = tmp();
    const r = inChild(
      cwd,
      `${load("system.ts")} new m.RememberSystem({ active_db: ":memory:", archive_dir: ".", auto_archive_enabled: false }).close();`,
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  test("FileIndexer accepts the current folder as its index folder", () => {
    const cwd = tmp();
    const r = inChild(cwd, `${load("file-indexer.ts")} new m.FileIndexer({ index_dir: "." });`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  test("FileIndexer accepts ./ as its index folder", () => {
    const cwd = tmp();
    const r = inChild(cwd, `${load("file-indexer.ts")} new m.FileIndexer({ index_dir: "./" });`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  test("a path that starts with ./ works for the database and the archive folder", () => {
    const cwd = tmp();
    const r = inChild(
      cwd,
      `${load("system.ts")} new m.RememberSystem({ active_db: "./store.db", archive_dir: "./", auto_archive_enabled: false }).close();`,
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "store.db"))).toBe(true);
  });

  test("an archive pass writes its files into the current folder", () => {
    const cwd = tmp();
    const r = inChild(
      cwd,
      `${load("system.ts")}
      const s = new m.RememberSystem({ active_db: ":memory:", archive_dir: ".", auto_archive_enabled: false });
      await s.addMemory({ content: "alpha runbook for the deploy key rotation" });
      const out = await s.archiveOldMemories({ age_days: 0, min_salience: 1.0 });
      console.log(JSON.stringify(out));
      s.close();`,
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const names = readdirSync(cwd);
    expect(names.some((n) => n.endsWith(".mp4"))).toBe(true);
    expect(names.some((n) => n.endsWith(".json"))).toBe(true);
  });
});

describe("the server with the default paths", () => {
  test("get_stats answers in an empty working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "remember-cwd-"));
    const server = spawnServer(cwd);
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
      const response = await sendJsonRpc(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_stats", arguments: {} },
      });
      expect(response).not.toBeNull();
      const result = response!.result as { isError?: boolean; content: { text: string }[] };
      if (result.isError) throw new Error(result.content[0]!.text);
      expect(result.isError).toBeUndefined();
      const stats = JSON.parse(result.content[0]!.text);
      expect(stats.active_count).toBe(0);
      expect(existsSync(join(cwd, "remember_mcp.db"))).toBe(true);
    } finally {
      server.proc.kill();
      await server.proc.exited;
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // the server may still hold the database for a moment
      }
    }
  }, 60_000);
});
