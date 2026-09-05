/**
 * MCP tool definitions and handlers for remember-mcp.
 */

import type { Tool } from "@modelcontextprotocol/server";
import { FileIndexer } from "./remember/file-indexer.ts";
import { ArchivalScheduler } from "./remember/scheduler.ts";
import { RememberSystem } from "./remember/system.ts";

export type ToolHandler = (raw: Record<string, unknown>) => Promise<unknown>;

let rememberSystem: RememberSystem | null = null;
let scheduler: ArchivalScheduler | null = null;
let fileIndexer: FileIndexer | null = null;
let initLock: Promise<void> = Promise.resolve();

async function withInitLock<T>(fn: () => T | Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const prev = initLock;
  initLock = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function getSystem(): RememberSystem {
  if (!rememberSystem) {
    rememberSystem = new RememberSystem({
      active_db: "remember_mcp.db",
      archive_dir: "mcp_archives/",
      archive_threshold_days: 60,
      archive_min_salience: 0.2,
      auto_archive_enabled: false,
    });
    scheduler = new ArchivalScheduler(rememberSystem, 86_400, false);
  }
  return rememberSystem;
}

function getFileIndexer(): FileIndexer {
  if (!fileIndexer) {
    fileIndexer = new FileIndexer({ index_dir: "file_index/" });
  }
  return fileIndexer;
}

async function agetSystem(): Promise<RememberSystem> {
  return withInitLock(() => getSystem());
}

async function agetFileIndexer(): Promise<FileIndexer> {
  return withInitLock(() => getFileIndexer());
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asOptionalStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function asOptionalBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "FileNotFoundError";
}

function isPermission(err: unknown): boolean {
  return err instanceof Error && err.name === "PermissionError";
}

export const TOOLS: Tool[] = [
  {
    name: "add_memory",
    description: "Add a new memory to active storage",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content" },
        user_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "query_memory",
    description: "Query memories with hybrid search",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "integer", minimum: 1, maximum: 100 },
        user_id: { type: "string" },
        include_archive: { type: "boolean" },
        sectors: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_memories",
    description: "Archive old/decayed memories to video",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        age_days: { type: "number" },
        min_salience: { type: "number" },
        user_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recall_memory",
    description: "Recall archived memory back to active storage",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        archive_file: { type: "string" },
        content: { type: "string" },
        user_id: { type: "string" },
      },
      required: ["archive_file", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stats",
    description: "Get system statistics",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "scheduler_status",
    description: "Get archival scheduler status",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "scheduler_control",
    description: "Control archival scheduler (start/stop/run_now)",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "run_now"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "index_file",
    description:
      "Index a file into video-encoded storage using QR codes. Supports text and code files. Paths must resolve inside REMEMBER_INDEX_ROOTS (default ~/Documents).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        chunk_size: { type: "integer" },
        overlap: { type: "integer" },
        preserve_lines: { type: "boolean" },
        index_dotfiles: { type: "boolean" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "index_directory",
    description:
      "Index all files in a directory matching a pattern. Confined to REMEMBER_INDEX_ROOTS.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        dir_path: { type: "string" },
        pattern: { type: "string" },
        exclude: { type: "array", items: { type: "string" } },
        chunk_size: { type: "integer" },
        overlap: { type: "integer" },
        index_dotfiles: { type: "boolean" },
      },
      required: ["dir_path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description: "Search across all indexed files using semantic search",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "integer" },
        file_filter: { type: "string" },
        file_type_filter: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_indexed_files",
    description: "List all files that have been indexed",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_file_info",
    description: "Get detailed information about an indexed file",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "get_file_stats",
    description: "Get statistics about the file index",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const HANDLERS: Record<string, ToolHandler> = {
  async add_memory(raw) {
    const system = await agetSystem();
    try {
      return await system.addMemory({
        content: String(raw.content ?? ""),
        user_id: asOptionalString(raw.user_id),
        tags: asOptionalStringList(raw.tags),
        metadata:
          raw.metadata && typeof raw.metadata === "object"
            ? (raw.metadata as Record<string, unknown>)
            : undefined,
      });
    } catch (err) {
      return { error: "invalid_argument", message: err instanceof Error ? err.message : String(err) };
    }
  },

  async query_memory(raw) {
    const system = await agetSystem();
    try {
      const results = await system.query({
        query: String(raw.query ?? ""),
        k: asOptionalNumber(raw.k) ?? 10,
        user_id: asOptionalString(raw.user_id),
        include_archive: asOptionalBool(raw.include_archive, true),
        sectors: asOptionalStringList(raw.sectors),
      });
      return results.map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        location: r.location,
        primary_sector: r.primary_sector,
        sectors: r.sectors,
        salience: r.salience,
        archived_at: r.archived_at ?? null,
        archive_file: r.archive_file ?? null,
      }));
    } catch (err) {
      return [{ error: "invalid_argument", message: err instanceof Error ? err.message : String(err) }];
    }
  },

  async archive_memories(raw) {
    const system = await agetSystem();
    try {
      const stats = await system.archiveOldMemories({
        age_days: asOptionalNumber(raw.age_days),
        min_salience: asOptionalNumber(raw.min_salience),
        user_id: asOptionalString(raw.user_id),
      });
      return {
        archived_count: stats.archived_count,
        active_remaining: stats.active_remaining,
        archive_size_bytes: stats.archive_size_bytes,
        compression_ratio: stats.compression_ratio,
      };
    } catch (err) {
      return { error: "invalid_argument", message: err instanceof Error ? err.message : String(err) };
    }
  },

  async recall_memory(raw) {
    const system = await agetSystem();
    try {
      return await system.recallFromArchive({
        archive_file: String(raw.archive_file ?? ""),
        content: String(raw.content ?? ""),
        user_id: asOptionalString(raw.user_id),
      });
    } catch (err) {
      if (isFileNotFound(err)) {
        return { error: "not_found", message: err instanceof Error ? err.message : String(err) };
      }
      return { error: "invalid_argument", message: err instanceof Error ? err.message : String(err) };
    }
  },

  async get_stats(raw) {
    const system = await agetSystem();
    const stats = await system.getStats(asOptionalString(raw.user_id));
    return {
      active_count: stats.active_count,
      archive_count: stats.archive_count,
      archive_file_count: stats.archive_file_count,
      total_memories: stats.total_memories,
      active_db_size: stats.active_db_size,
      archive_size: stats.archive_size,
      total_size: stats.total_size,
      compression_ratio: stats.compression_ratio,
      avg_salience: stats.avg_salience,
    };
  },

  async scheduler_status() {
    await agetSystem();
    if (!scheduler) return { error: "Scheduler not initialized" };
    return scheduler.getStatus();
  },

  async scheduler_control(raw) {
    await agetSystem();
    if (!scheduler) return { error: "Scheduler not initialized" };
    const action = String(raw.action ?? "");
    if (action === "start") {
      await scheduler.start();
      return { status: "Scheduler started" };
    }
    if (action === "stop") {
      await scheduler.stop();
      return { status: "Scheduler stopped" };
    }
    if (action === "run_now") {
      await scheduler.runNow();
      return { status: "Archival triggered" };
    }
    return {
      error: "invalid_argument",
      message: `Unknown action: ${action}. Expected start, stop, or run_now.`,
    };
  },

  async index_file(raw) {
    const indexer = await agetFileIndexer();
    try {
      return await indexer.indexFile({
        file_path: String(raw.file_path ?? ""),
        chunk_size: asOptionalNumber(raw.chunk_size),
        overlap: asOptionalNumber(raw.overlap),
        preserve_lines: asOptionalBool(raw.preserve_lines, true),
        index_dotfiles: asOptionalBool(raw.index_dotfiles, false),
      });
    } catch (err) {
      if (isPermission(err)) {
        return { error: "permission_denied", message: err instanceof Error ? err.message : String(err) };
      }
      if (isFileNotFound(err)) {
        return { error: "not_found", message: err instanceof Error ? err.message : String(err) };
      }
      return { error: "invalid_argument", message: err instanceof Error ? err.message : String(err) };
    }
  },

  async index_directory(raw) {
    const indexer = await agetFileIndexer();
    try {
      return await indexer.indexDirectory({
        dir_path: String(raw.dir_path ?? ""),
        pattern: asOptionalString(raw.pattern),
        exclude: asOptionalStringList(raw.exclude),
        chunk_size: asOptionalNumber(raw.chunk_size),
        overlap: asOptionalNumber(raw.overlap),
        index_dotfiles: asOptionalBool(raw.index_dotfiles, false),
      });
    } catch (err) {
      if (isPermission(err)) {
        return { error: "permission_denied", message: err instanceof Error ? err.message : String(err) };
      }
      if (isFileNotFound(err)) {
        return { error: "not_found", message: err instanceof Error ? err.message : String(err) };
      }
      return { error: "invalid_argument", message: err instanceof Error ? err.message : String(err) };
    }
  },

  async search_files(raw) {
    const indexer = await agetFileIndexer();
    try {
      return indexer.search({
        query: String(raw.query ?? ""),
        top_k: asOptionalNumber(raw.top_k),
        file_filter: asOptionalString(raw.file_filter),
        file_type_filter: asOptionalString(raw.file_type_filter),
      });
    } catch (err) {
      return [{ error: "invalid_argument", message: err instanceof Error ? err.message : String(err) }];
    }
  },

  async list_indexed_files() {
    const indexer = await agetFileIndexer();
    return indexer.listIndexedFiles();
  },

  async get_file_info(raw) {
    const indexer = await agetFileIndexer();
    return indexer.getFileInfo(String(raw.file_path ?? ""));
  },

  async get_file_stats() {
    const indexer = await agetFileIndexer();
    return indexer.getStats();
  },
};

/** Eagerly warm heavy paths (tests/benchmarks). Not used by stdio main(). */
export async function setup(): Promise<void> {
  await agetSystem();
  await agetFileIndexer();
}

export function shutdown(): void {
  try {
    rememberSystem?.close();
  } catch (err) {
    console.error("Error closing remember_system:", err);
  }
  try {
    fileIndexer?.close();
  } catch (err) {
    console.error("Error closing file_indexer:", err);
  }
  rememberSystem = null;
  fileIndexer = null;
  scheduler = null;
}

/** Exposed for tests that assert registration without spawning stdio. */
export function listRegisteredToolNames(): string[] {
  return TOOLS.map((t) => t.name);
}
