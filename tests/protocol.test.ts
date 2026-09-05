import { describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { exchange, spawnServer, sendJsonRpc } from "./mcp-stdio.ts";

const EXPECTED_TOOL_NAMES = new Set([
  "add_memory",
  "query_memory",
  "archive_memories",
  "recall_memory",
  "get_stats",
  "scheduler_status",
  "scheduler_control",
  "index_file",
  "index_directory",
  "search_files",
  "list_indexed_files",
  "get_file_info",
  "get_file_stats",
]);

describe("MCP protocol", () => {
  test("initialize negotiates a supported protocol version", async () => {
    const [response] = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "remember-mcp-test", version: "0.0.1" },
        },
      },
    ]);
    expect(response).not.toBeNull();
    expect(response!.error).toBeUndefined();
    const result = response!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("remember");
  });

  test("tools/list returns the expected surface after initialize", async () => {
    const server = spawnServer();
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
      server.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      await server.stdin.flush();

      const listed = await sendJsonRpc(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect(listed).not.toBeNull();
      expect(listed!.error).toBeUndefined();
      const tools = (listed!.result as { tools: Array<{ name: string }> }).tools;
      const names = new Set(tools.map((t) => t.name));
      expect(names).toEqual(EXPECTED_TOOL_NAMES);
    } finally {
      server.proc.kill();
      await server.proc.exited;
    }
  });

  test("initialize completes within startup budget", async () => {
    const budgetSec = 10;
    const server = spawnServer();
    try {
      const t0 = performance.now();
      const response = await sendJsonRpc(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "timing-test", version: "0.0.1" },
        },
      });
      const elapsed = (performance.now() - t0) / 1000;
      expect(response).not.toBeNull();
      expect(elapsed).toBeLessThan(budgetSec);
    } finally {
      server.proc.kill();
      await server.proc.exited;
    }
  });
});
