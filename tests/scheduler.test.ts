import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { ArchivalScheduler } from "../src/remember/scheduler.ts";
import type { RememberSystem } from "../src/remember/system.ts";
import { sendJsonRpc, spawnServer } from "./mcp-stdio.ts";

/** A memory system that counts the archive passes and returns a fixed number of archived memories. */
function stubSystem(archived: number, fail = false) {
  const calls: Array<{ age_days: number; min_salience: number }> = [];
  const system = {
    archiveThresholdDays: 60,
    archiveMinSalience: 0.2,
    async archiveOldMemories(options: { age_days: number; min_salience: number }) {
      calls.push(options);
      if (fail) throw new Error("archive failed");
      return { archived_count: archived };
    },
  } as unknown as RememberSystem;
  return { system, calls };
}

describe("ArchivalScheduler.runNow", () => {
  test("runs one pass although the scheduler was never started", async () => {
    const { system, calls } = stubSystem(3);
    // The MCP server builds its scheduler like this: `enabled` is false until the first `start`.
    const scheduler = new ArchivalScheduler(system, 3600, false);
    expect(scheduler.last_run).toBeNull();

    await scheduler.runNow();

    expect(calls).toEqual([{ age_days: 60, min_salience: 0.2 }]);
    expect(scheduler.last_run).not.toBeNull();
    expect(scheduler.total_archived).toBe(3);
    expect(scheduler.last_error).toBeNull();
  });

  test("keeps `enabled` as it was", async () => {
    const { system } = stubSystem(1);
    const scheduler = new ArchivalScheduler(system, 3600, false);
    await scheduler.runNow();
    expect(scheduler.enabled).toBe(false);
    expect(scheduler.running).toBe(false);
  });

  test("adds the counts of two passes", async () => {
    const { system, calls } = stubSystem(2);
    const scheduler = new ArchivalScheduler(system, 3600, false);
    await scheduler.runNow();
    await scheduler.runNow();
    expect(calls.length).toBe(2);
    expect(scheduler.total_archived).toBe(4);
  });

  test("rejects and records the error when the pass fails", async () => {
    const { system } = stubSystem(0, true);
    const scheduler = new ArchivalScheduler(system, 3600, false);
    await expect(scheduler.runNow()).rejects.toThrow("archive failed");
    expect(scheduler.last_error).toBe("archive failed");
    expect(scheduler.last_run).toBeNull();
  });
});

describe("ArchivalScheduler timer", () => {
  test("start runs a pass at once, and stop ends the timer", async () => {
    const { system, calls } = stubSystem(1);
    const scheduler = new ArchivalScheduler(system, 3600, false);
    await scheduler.start();
    expect(scheduler.enabled).toBe(true);
    const deadline = Date.now() + 5000;
    while (calls.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    await scheduler.stop();
    expect(calls.length).toBe(1);
    expect(scheduler.running).toBe(false);
  });

  test("a timer pass does nothing while `enabled` is false", async () => {
    const { system, calls } = stubSystem(1);
    const scheduler = new ArchivalScheduler(system, 3600, true);
    scheduler.enabled = false;
    await scheduler.start();
    // `start` sets `enabled` to true, so clear it again before the first timer pass can run.
    scheduler.enabled = false;
    await Bun.sleep(50);
    await scheduler.stop();
    expect(calls.length).toBe(0);
    expect(scheduler.last_run).toBeNull();
  });
});

describe("scheduler_control run_now over MCP", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // the server may still hold the database for a moment
      }
    }
  });

  test("a run_now before start sets last_run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "remember-sched-"));
    dirs.push(cwd);
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
        return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      };

      const before = await call("scheduler_status", {});
      expect(before.last_run).toBeNull();
      expect(before.enabled).toBe(false);

      const triggered = await call("scheduler_control", { action: "run_now" });
      expect(triggered.status).toBe("Archival triggered");

      const after = await call("scheduler_status", {});
      expect(typeof after.last_run).toBe("number");
      expect(after.running).toBe(false);
      expect(after.last_error).toBeNull();
    } finally {
      server.proc.kill();
      await server.proc.exited;
    }
  }, 60_000);
});
