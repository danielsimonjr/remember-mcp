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

/**
 * How long `sendJsonRpc` waits for a reply, unless the caller gives another limit. It stays under the 120 s that a
 * slow test may run (an ffmpeg encode on a CI runner), so a server that never answers fails its call first.
 */
const REPLY_TIMEOUT_MS = 100_000;

/**
 * The lines of one server's stdout. One instance reads the whole session, so a line that arrives with the line
 * before it is kept for the next request, and a read that outlives its deadline is not lost.
 */
class LineReader {
  private readonly read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  private readonly decoder = new TextDecoder();
  private buf = "";
  private pending: ReturnType<LineReader["read"]> | null = null;
  private ended = false;
  /** True while a request waits for its reply: two callers of `next` would each append the chunk of one read. */
  busy = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    this.read = () => reader.read();
  }

  /** The next line, or null when the stream has ended or `deadline` (a `Date.now()` value) has passed. */
  async next(deadline: number): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      const remaining = deadline - Date.now();
      if (this.ended || remaining <= 0) return null;
      // A read that loses the race stays in `pending`, and the next call waits for the same read.
      this.pending ??= this.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<null>((resolve) => {
        timer = setTimeout(resolve, remaining, null);
      });
      try {
        const chunk = await Promise.race([this.pending, expired]);
        if (chunk === null) return null;
        this.pending = null;
        if (chunk.done) this.ended = true;
        else this.buf += this.decoder.decode(chunk.value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

const lineReaders = new WeakMap<ServerProc, LineReader>();

/**
 * Send one request and return the reply with the same id, or null when the stream ends or `timeoutMs` passes.
 * Every other message is read and skipped: a notification, a request from the server, a reply to an earlier request.
 * A line that is not JSON throws, because the server writes nothing but protocol messages to stdout.
 * One request waits on a server at a time, because the reply to any other request would be skipped.
 */
export async function sendJsonRpc(
  server: ServerProc,
  message: Record<string, unknown>,
  timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const id = message.id;
  if (id === undefined) throw new Error("sendJsonRpc needs a request id: a message with no id gets no reply");
  let lines = lineReaders.get(server);
  if (!lines) {
    lines = new LineReader(server.stdout);
    lineReaders.set(server, lines);
  }
  if (lines.busy) throw new Error("sendJsonRpc: another request is still waiting for its reply on this server");
  lines.busy = true;
  try {
    server.stdin.write(JSON.stringify(message) + "\n");
    await server.stdin.flush();

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await lines.next(deadline);
      if (line === null) return null;
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.id === id && !("method" in parsed)) return parsed;
    }
  } finally {
    lines.busy = false;
  }
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
  const close = async () => {
    server.proc.kill();
    await server.proc.exited;
  };
  try {
    const init = await request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "remember-mcp-test", version: "0.0.1" },
    });
    if (!init?.result) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await server.stdin.flush();
  } catch (err) {
    await close();
    throw err;
  }
  return {
    server,
    request,
    close,
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
  };
}
