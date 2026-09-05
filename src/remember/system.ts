/**
 * RememberSystem — hybrid active (SQLite) + archive (QR video) manager.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ActiveStore } from "./active-store.ts";
import {
  encodeChunks,
  searchSidecar,
  sidecarChunkCount,
} from "./archive.ts";
import {
  type ArchiveIndex,
  type ArchiveInfo,
  type ArchiveStats,
  type HybridMemoryResult,
  MemoryLocation,
  type SystemStats,
} from "./types.ts";

export const MAX_CONTENT_CHARS = 100_000;
export const MAX_QUERY_K = 100;

function stableChunkId(timestamp: string, chunk: string): string {
  const digest = createHash("sha256").update(chunk, "utf8").digest("hex").slice(0, 16);
  return `archive_${timestamp}_${digest}`;
}

export interface RememberSystemOptions {
  active_db?: string;
  archive_dir?: string;
  archive_threshold_days?: number;
  archive_min_salience?: number;
  auto_archive_enabled?: boolean;
}

export class RememberSystem {
  readonly activeDb: string;
  readonly archiveDir: string;
  readonly archiveThresholdDays: number;
  readonly archiveMinSalience: number;
  readonly autoArchiveEnabled: boolean;
  readonly active: ActiveStore;
  archiveIndex: ArchiveIndex = {};
  private writeLock: Promise<void> = Promise.resolve();
  private archiveLock: Promise<void> = Promise.resolve();

  constructor(opts: RememberSystemOptions = {}) {
    this.activeDb = opts.active_db ?? "remember_active.db";
    this.archiveDir = opts.archive_dir ?? "archives/";
    this.archiveThresholdDays = opts.archive_threshold_days ?? 60;
    this.archiveMinSalience = opts.archive_min_salience ?? 0.2;
    this.autoArchiveEnabled = opts.auto_archive_enabled ?? false;

    mkdirSync(this.archiveDir, { recursive: true });
    this.active = new ActiveStore(this.activeDb);
    this._loadArchiveIndex();
  }

  /** Normalize user_id into the archive bookkeeping key (`None` → `"default"`). */
  static archiveKey(userId?: string | null): string {
    return userId || "default";
  }

  private async withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.writeLock;
    this.writeLock = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withArchiveLock<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.archiveLock;
    this.archiveLock = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private _loadArchiveIndex(): void {
    if (!existsSync(this.archiveDir)) return;
    for (const name of readdirSync(this.archiveDir)) {
      if (!name.endsWith(".mp4")) continue;
      const stem = name.slice(0, -4);
      if (!stem.startsWith("user_")) continue;
      const rest = stem.slice("user_".length);
      const lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore <= 0) continue;
      const userId = rest.slice(0, lastUnderscore);
      const timestamp = rest.slice(lastUnderscore + 1);
      if (!/^\d+$/.test(timestamp)) continue;

      const videoPath = join(this.archiveDir, name);
      const indexPath = join(this.archiveDir, `${stem}.json`);
      if (!this.archiveIndex[userId]) this.archiveIndex[userId] = {};
      this.archiveIndex[userId]![timestamp] = {
        file: videoPath,
        index: indexPath,
        created_at: Number(timestamp),
        memory_count: sidecarChunkCount(indexPath),
      };
    }
  }

  private static validateContent(content: string): string {
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("content must be a non-empty string");
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(
        `content exceeds ${MAX_CONTENT_CHARS} characters (${content.length} given)`,
      );
    }
    return content;
  }

  private static validateK(k: number, name = "k"): number {
    if (!Number.isInteger(k) || k < 1 || k > MAX_QUERY_K) {
      throw new Error(`${name} must be an integer between 1 and ${MAX_QUERY_K}`);
    }
    return k;
  }

  async addMemory(opts: {
    content: string;
    user_id?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<Record<string, unknown>> {
    const content = RememberSystem.validateContent(opts.content);
    const result = await this.withWriteLock(() =>
      this.active.addMemory({
        content,
        user_id: opts.user_id,
        tags: opts.tags,
        metadata: opts.metadata,
      }),
    );
    return { ...result, location: MemoryLocation.ACTIVE };
  }

  async query(opts: {
    query: string;
    k?: number;
    user_id?: string | null;
    include_archive?: boolean;
    sectors?: string[] | null;
  }): Promise<HybridMemoryResult[]> {
    if (typeof opts.query !== "string" || !opts.query.trim()) {
      throw new Error("query must be a non-empty string");
    }
    const k = RememberSystem.validateK(opts.k ?? 10);
    const includeArchive = opts.include_archive !== false;

    const results: HybridMemoryResult[] = [];
    const active = this.active.query({
      query: opts.query,
      k,
      user_id: opts.user_id,
      sectors: opts.sectors,
    });

    for (const mem of active) {
      results.push({
        id: mem.id,
        content: mem.content,
        score: mem.score ?? 0,
        location: MemoryLocation.ACTIVE,
        sectors: mem.sectors,
        primary_sector: mem.primary_sector,
        salience: mem.salience,
        last_seen_at: mem.last_seen_at,
      });
    }

    if (includeArchive && RememberSystem.archiveKey(opts.user_id) in this.archiveIndex) {
      results.push(
        ...(await this._queryArchives(opts.query, opts.user_id, k)),
      );
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  private async _queryArchives(
    query: string,
    userId: string | null | undefined,
    k: number,
  ): Promise<HybridMemoryResult[]> {
    const userArchives = this.archiveIndex[RememberSystem.archiveKey(userId)] ?? {};
    const results: HybridMemoryResult[] = [];

    for (const [timestamp, info] of Object.entries(userArchives)) {
      try {
        const hits = searchSidecar(info.index, query, k);
        for (const hit of hits) {
          results.push({
            id: stableChunkId(timestamp, hit.text),
            content: hit.text,
            score: hit.score * 0.8,
            location: MemoryLocation.ARCHIVE,
            sectors: ["semantic"],
            primary_sector: "semantic",
            salience: 0,
            last_seen_at: info.created_at,
            archived_at: info.created_at,
            archive_file: info.file,
          });
        }
      } catch (err) {
        console.error(`Error querying archive ${info.file}:`, err);
      }
    }
    return results;
  }

  async archiveOldMemories(opts: {
    age_days?: number | null;
    min_salience?: number | null;
    user_id?: string | null;
  } = {}): Promise<ArchiveStats> {
    let ageDays =
      opts.age_days === null || opts.age_days === undefined
        ? this.archiveThresholdDays
        : Number(opts.age_days);
    let minSalience =
      opts.min_salience === null || opts.min_salience === undefined
        ? this.archiveMinSalience
        : Number(opts.min_salience);
    ageDays = Math.trunc(ageDays);
    if (ageDays < 0) throw new Error("age_days must be >= 0");

    const ageThresholdMs = Date.now() - ageDays * 24 * 60 * 60 * 1000;

    return this.withArchiveLock(async () => {
      const eligible = await this.withWriteLock(() =>
        this.active.selectEligible({
          user_id: opts.user_id,
          age_threshold_ms: ageThresholdMs,
          min_salience: minSalience,
        }),
      );

      if (eligible.length === 0) {
        return {
          archived_count: 0,
          active_remaining: this.active.count(opts.user_id),
          archive_size_bytes: 0,
          compression_ratio: 1,
        };
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const archiveFilename = `user_${RememberSystem.archiveKey(opts.user_id)}_${timestamp}`;
      const videoPath = join(this.archiveDir, `${archiveFilename}.mp4`);
      const indexPath = join(this.archiveDir, `${archiveFilename}.json`);
      const memoryIds = eligible.map((m) => m.id);
      const contents = eligible.map((m) => m.content);

      try {
        await encodeChunks(contents, videoPath, indexPath);
      } catch (err) {
        console.error(`Memvid encoding failed for ${videoPath}:`, err);
        return {
          archived_count: 0,
          active_remaining: this.active.count(opts.user_id),
          archive_size_bytes: 0,
          compression_ratio: 1,
        };
      }

      return this.withWriteLock(() =>
        this._commitArchive({
          user_id: opts.user_id,
          timestamp,
          videoPath,
          indexPath,
          memoryIds,
          originalSize: contents.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0),
        }),
      );
    });
  }

  private _commitArchive(opts: {
    user_id?: string | null;
    timestamp: number;
    videoPath: string;
    indexPath: string;
    memoryIds: string[];
    originalSize: number;
  }): ArchiveStats {
    const key = RememberSystem.archiveKey(opts.user_id);
    if (!this.archiveIndex[key]) this.archiveIndex[key] = {};
    this.archiveIndex[key]![String(opts.timestamp)] = {
      file: opts.videoPath,
      index: opts.indexPath,
      created_at: opts.timestamp,
      memory_count: opts.memoryIds.length,
    };

    this.active.deleteByIds(opts.memoryIds);

    let archiveSize = 0;
    try {
      archiveSize = statSync(opts.videoPath).size;
    } catch {
      archiveSize = 0;
    }

    return {
      archived_count: opts.memoryIds.length,
      active_remaining: this.active.count(opts.user_id),
      archive_size_bytes: archiveSize,
      compression_ratio: archiveSize > 0 ? opts.originalSize / archiveSize : 1,
    };
  }

  private _lookupArchive(
    archiveFile: string,
    userId?: string | null,
  ): ArchiveInfo | null {
    if (!archiveFile || typeof archiveFile !== "string") return null;
    const needle = basename(archiveFile);
    const stem = basename(needle, extname(needle));
    const key = RememberSystem.archiveKey(userId);
    const scopes =
      userId == null
        ? Object.values(this.archiveIndex)
        : [this.archiveIndex[key] ?? {}];

    for (const archives of scopes) {
      for (const info of Object.values(archives)) {
        const filePath = info.file || "";
        const fileName = basename(filePath);
        const fileStem = basename(filePath, extname(filePath));
        if (
          archiveFile === filePath ||
          archiveFile === fileName ||
          archiveFile === fileStem ||
          needle === fileName ||
          needle === fileStem ||
          stem === fileStem
        ) {
          return info;
        }
      }
    }
    return null;
  }

  async recallFromArchive(opts: {
    archive_file: string;
    content: string;
    user_id?: string | null;
  }): Promise<Record<string, unknown>> {
    const content = RememberSystem.validateContent(opts.content);
    const info = this._lookupArchive(opts.archive_file, opts.user_id);
    // Tagged FileNotFoundError so MCP tools can map it like the Python server.
    if (!info) {
      throw Object.assign(new Error(`Unknown archive: ${opts.archive_file}`), {
        name: "FileNotFoundError",
      });
    }
    if (!existsSync(info.file)) {
      throw Object.assign(new Error(`Archive file missing on disk: ${info.file}`), {
        name: "FileNotFoundError",
      });
    }
    return this.addMemory({
      content,
      user_id: opts.user_id,
      metadata: { recalled_from: info.file },
    });
  }

  private _archiveTotals(
    userId?: string | null,
  ): { memoryCount: number; fileCount: number; sizeBytes: number } {
    const groups = userId
      ? [this.archiveIndex[RememberSystem.archiveKey(userId)] ?? {}]
      : Object.values(this.archiveIndex);

    let memoryCount = 0;
    let fileCount = 0;
    let sizeBytes = 0;
    for (const archives of groups) {
      fileCount += Object.keys(archives).length;
      for (const info of Object.values(archives)) {
        memoryCount += Number(info.memory_count || 0);
        try {
          sizeBytes += statSync(info.file).size;
        } catch {
          // missing file
        }
      }
    }
    return { memoryCount, fileCount, sizeBytes };
  }

  async getStats(userId?: string | null): Promise<SystemStats> {
    const { count: activeCount, avg: avgSalience } =
      this.active.countAndAvgSalience(userId);
    const { memoryCount, fileCount, sizeBytes } = this._archiveTotals(userId);

    let activeDbSize = 0;
    if (existsSync(this.activeDb)) {
      try {
        activeDbSize = statSync(this.activeDb).size;
      } catch {
        activeDbSize = 0;
      }
    }

    const totalSize = activeDbSize + sizeBytes;
    return {
      active_count: activeCount,
      archive_count: memoryCount,
      archive_file_count: fileCount,
      total_memories: activeCount + memoryCount,
      active_db_size: activeDbSize,
      archive_size: sizeBytes,
      total_size: totalSize,
      compression_ratio: activeDbSize > 0 ? totalSize / activeDbSize : 1,
      avg_salience: avgSalience,
    };
  }

  close(): void {
    this.active.close();
  }
}

export { MemoryLocation };
