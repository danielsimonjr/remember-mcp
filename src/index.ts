#!/usr/bin/env bun
/**
 * Main MCP server entry for remember-mcp (Bun + TypeScript).
 *
 * Speaks whatever protocol revision `@modelcontextprotocol/server` negotiates
 * (see LATEST_PROTOCOL_VERSION). Heavy work (SQLite + QR/ffmpeg archival) is
 * deferred to the first tools/call so MCP initialize stays sub-second.
 */

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.ts";
import { shutdown } from "./tools.ts";

const handle = serveStdio(buildServer);

process.stderr.write(
  `remember-mcp: serving on stdio (MCP ${LATEST_PROTOCOL_VERSION} + legacy)\n`,
);

const cleanup = async () => {
  try {
    shutdown();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore — process is exiting
    }
  }
};

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});
