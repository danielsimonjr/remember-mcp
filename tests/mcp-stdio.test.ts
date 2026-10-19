import { describe, expect, test } from "bun:test";
import { sendJsonRpc, type ServerProc } from "./mcp-stdio.ts";

/**
 * A server whose output the test writes by hand: `push` adds output, `end` closes it, and `written` holds
 * what the client sent. No process runs, so a test sets the exact order and timing of the lines.
 */
function scriptedServer() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const written: string[] = [];
  const server = {
    stdin: {
      write(data: string) {
        written.push(data);
        return data.length;
      },
      flush: () => 0,
    },
    stdout,
  } as unknown as ServerProc;
  return {
    server,
    written,
    push: (data: string | Uint8Array) => controller.enqueue(typeof data === "string" ? encoder.encode(data) : data),
    end: () => controller.close(),
  };
}

const line = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";
const request = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const reply = (id: number) => line({ jsonrpc: "2.0", id, result: { for: id } });

describe("sendJsonRpc", () => {
  test("returns the reply to the request, not the line before it", async () => {
    const s = scriptedServer();
    s.push(line({ jsonrpc: "2.0", method: "notifications/message", params: { data: "stray" } }) + reply(1));
    const response = await sendJsonRpc(s.server, request(1));
    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { for: 1 } });
  });

  test("a request from the server that reuses the id is not the reply", async () => {
    const s = scriptedServer();
    s.push(line({ jsonrpc: "2.0", id: 1, method: "ping" }) + reply(1));
    const response = await sendJsonRpc(s.server, request(1));
    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { for: 1 } });
  });

  test("an error reply with the same id is the reply", async () => {
    const s = scriptedServer();
    const error = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
    s.push(line(error));
    expect(await sendJsonRpc(s.server, request(1))).toEqual(error);
  });

  test("a blank line is skipped", async () => {
    const s = scriptedServer();
    s.push("\n" + reply(1));
    expect((await sendJsonRpc(s.server, request(1)))?.id).toBe(1);
  });

  test("lines that arrive together are kept for the next request", async () => {
    const s = scriptedServer();
    s.push(reply(1) + reply(2));
    s.end();
    expect((await sendJsonRpc(s.server, request(1)))?.id).toBe(1);
    expect((await sendJsonRpc(s.server, request(2)))?.id).toBe(2);
  });

  test("a reply split across two chunks is joined", async () => {
    const s = scriptedServer();
    const whole = reply(1);
    s.push(whole.slice(0, 10));
    const pending = sendJsonRpc(s.server, request(1));
    s.push(whole.slice(10));
    expect((await pending)?.id).toBe(1);
  });

  test("a character split across two chunks is decoded whole", async () => {
    const s = scriptedServer();
    const bytes = new TextEncoder().encode(line({ jsonrpc: "2.0", id: 1, result: { text: "é" } }));
    const cut = bytes.indexOf(0xc3) + 1;
    s.push(bytes.slice(0, cut));
    const pending = sendJsonRpc(s.server, request(1));
    s.push(bytes.slice(cut));
    expect(((await pending)?.result as { text: string }).text).toBe("é");
  });

  test("a silent server gives null at the deadline", async () => {
    const s = scriptedServer();
    const started = Date.now();
    expect(await sendJsonRpc(s.server, request(1), 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a stream that closes with nothing gives null at once", async () => {
    const s = scriptedServer();
    s.end();
    const started = Date.now();
    expect(await sendJsonRpc(s.server, request(1), 10_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a last line with no line break is not a reply", async () => {
    const s = scriptedServer();
    s.push(reply(1).trimEnd());
    s.end();
    const started = Date.now();
    expect(await sendJsonRpc(s.server, request(1), 10_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a reply that comes after the deadline is not lost and is not taken for the next answer", async () => {
    const s = scriptedServer();
    expect(await sendJsonRpc(s.server, request(1), 20)).toBeNull();
    const second = sendJsonRpc(s.server, request(2), 2_000);
    s.push(reply(1) + reply(2));
    expect(await second).toEqual({ jsonrpc: "2.0", id: 2, result: { for: 2 } });
  });

  test("a message with no id is refused before anything is written", async () => {
    const s = scriptedServer();
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    await expect(sendJsonRpc(s.server, notification, 50)).rejects.toThrow(/id/);
    expect(s.written).toEqual([]);
  });

  test("a second request while one waits is refused and does not disturb the first", async () => {
    const s = scriptedServer();
    const first = sendJsonRpc(s.server, request(1), 2_000);
    await expect(sendJsonRpc(s.server, request(2), 50)).rejects.toThrow(/waiting/);
    s.push(reply(1));
    expect((await first)?.id).toBe(1);
    expect(s.written).toEqual([JSON.stringify(request(1)) + "\n"]);
  });
});
