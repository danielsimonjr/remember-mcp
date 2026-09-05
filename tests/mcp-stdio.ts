/**
 * Stdio protocol helpers for integration tests.
 */
import { join } from "node:path";

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

export function spawnServer(): ServerProc {
  const proc = Bun.spawn(["bun", "run", SERVER], {
    cwd: REPO,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
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
