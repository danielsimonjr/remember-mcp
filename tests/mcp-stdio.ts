/**
 * Stdio protocol helpers for integration tests.
 */
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

export const REPO = join(import.meta.dir, "..");
export const SERVER = join(REPO, "src", "index.ts");

type StdinSink = {
  write(data: string | ArrayBufferView | ArrayBuffer): number;
  flush(): number | Promise<number>;
};

export type ServerProc = {
  proc: ReturnType<typeof Bun.spawn>;
  stdin: StdinSink;
  stdout: ReadableStream<Uint8Array>;
};

export function spawnServer(cwd: string = REPO, env: Record<string, string> = {}): ServerProc {
  const proc = Bun.spawn(["bun", "run", SERVER], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  if (typeof proc.stdin === "number" || !proc.stdin) {
    throw new Error("expected piped stdin");
  }
  if (!(proc.stdout instanceof ReadableStream)) {
    throw new Error("expected piped stdout");
  }
  return { proc, stdin: proc.stdin as StdinSink, stdout: proc.stdout };
}

export async function sendJsonRpc(
  server: ServerProc,
  message: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const payload = JSON.stringify(message) + "\n";
  server.stdin.write(payload);
  await server.stdin.flush();

  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        if (!line) return null;
        return JSON.parse(line) as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

export async function exchange(
  messages: Record<string, unknown>[],
): Promise<Array<Record<string, unknown> | null>> {
  const server = spawnServer();
  const responses: Array<Record<string, unknown> | null> = [];
  try {
    for (const message of messages) {
      responses.push(await sendJsonRpc(server, message));
    }
  } finally {
    server.proc.kill();
    await server.proc.exited;
  }
  return responses;
}

/** The result of one `tools/call`: the parsed JSON text of the first content item, and the `isError` flag. */
export type ToolCallResult = { value: unknown; isError: boolean };

export type ToolSession = {
  server: ServerProc;
  /** Send one `tools/call` and return its parsed result. */
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** Send one raw JSON-RPC request after the handshake and return the response. */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
};

/**
 * Start the server in `cwd`, finish the MCP handshake, and return a session that calls tools.
 * `env` is added to the environment of the server only, so the test process keeps its own.
 */
export async function openToolSession(cwd: string, env: Record<string, string> = {}): Promise<ToolSession> {
  const server = spawnServer(cwd, env);
  let id = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    sendJsonRpc(server, { jsonrpc: "2.0", id: ++id, method, params });
  try {
    await request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "remember-mcp-test", version: "0.0.1" },
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await server.stdin.flush();
  } catch (err) {
    server.proc.kill();
    await server.proc.exited;
    throw err;
  }
  return {
    server,
    request,
    async call(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      if (!response) throw new Error(`no response to tools/call ${name}`);
      const result = response.result as { isError?: boolean; content: { text: string }[] } | undefined;
      if (!result) throw new Error(`tools/call ${name} returned a protocol error: ${JSON.stringify(response.error)}`);
      const text = result.content[0]?.text ?? "";
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // an error message from the SDK is plain text
      }
      return { value, isError: result.isError === true };
    },
    async close() {
      server.proc.kill();
      await server.proc.exited;
    },
  };
}
