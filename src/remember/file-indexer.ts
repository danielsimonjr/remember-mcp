/**
 * File indexing via QR-encoded video storage.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { encodeChunks, searchSidecar } from "./archive.ts";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORY_FILES = 500;
const MAX_QUERY_K = 100;
const MIN_CHUNK_SIZE = 32;
const MAX_CHUNK_SIZE = 1_000_000;
const DEFAULT_EXCLUDES = [".git", "__pycache__", "node_modules", ".pyc", ".mp4", ".mp3"];
const CODE_TYPES = new Set(["python", "javascript", "typescript", "java", "cpp", "c"]);

const TYPE_MAP: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".java": "java",
  ".cpp": "cpp",
  ".c": "c",
  ".h": "header",
  ".md": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
  ".epub": "epub",
  ".html": "html",
  ".css": "css",
  ".json": "json",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

function getAllowedIndexRoots(): string[] {
  const raw = process.env.REMEMBER_INDEX_ROOTS ?? "";
  if (raw.trim()) {
    return raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p.replace(/^~(?=$|[/\\])/, homedir())));
  }
  return [resolve(join(homedir(), "Documents"))];
}

function isWithinAllowedRoots(absPath: string, roots: string[]): boolean {
  const resolved = resolve(absPath);
  for (const root of roots) {
    if (resolved === root) return true;
    const rel = relative(root, resolved);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

function isDotfilePath(path: string): boolean {
  return path.split(/[/\\]/).some((part) => {
    if (!part || part === "/" || part === "\\") return false;
    if (part.length >= 2 && part[1] === ":") return false;
    return part.startsWith(".");
  });
}

function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

function chunkCodeWithLines(
  content: string,
  filename: string,
  chunkSize: number,
): { chunks: string[]; meta: Array<Record<string, number>> } {
  const lines = content.split("\n");
  const nLines = lines.length;
  const step = Math.max(1, Math.floor(chunkSize / 50));
  const offsets = new Array<number>(nLines + 1).fill(0);
  for (let i = 0; i < nLines; i++) {
    offsets[i + 1] = offsets[i]! + lines[i]!.length + 1;
  }

  const chunks: string[] = [];
  const meta: Array<Record<string, number>> = [];
  for (let start = 0; start < nLines; start += step) {
    const end = Math.min(start + step, nLines);
    const startLine = start + 1;
    const endLine = end;
    const chunkText =
      `[${filename}:${startLine}-${endLine}]\n` + lines.slice(start, end).join("\n");
    chunks.push(chunkText);
    meta.push({
      start_line: startLine,
      end_line: endLine,
      char_start: offsets[start]!,
      char_end: offsets[end]!,
    });
  }
  return { chunks, meta };
}

function chunkText(content: string, chunkSize: number, overlap: number): string[] {
  if (content.length <= chunkSize) return [content];
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + chunkSize, content.length);
    chunks.push(content.slice(start, end));
    if (end >= content.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export interface FileIndexerOptions {
  index_dir?: string;
  allowed_roots?: string[] | null;
  max_file_bytes?: number;
  max_directory_files?: number;
}

type FileMeta = Record<string, unknown>;

export class FileIndexer {
  readonly indexDir: string;
  readonly allowedRoots: string[];
  readonly maxFileBytes: number;
  readonly maxDirectoryFiles: number;
  readonly metadataFile: string;
  metadata: Record<string, FileMeta>;

  constructor(opts: FileIndexerOptions = {}) {
    this.indexDir = opts.index_dir ?? "file_index/";
    mkdirSync(this.indexDir, { recursive: true });
    this.maxFileBytes = opts.max_file_bytes ?? MAX_FILE_BYTES;
    this.maxDirectoryFiles = opts.max_directory_files ?? MAX_DIRECTORY_FILES;
    this.allowedRoots =
      opts.allowed_roots != null
        ? opts.allowed_roots.map((p) =>
            resolve(p.replace(/^~(?=$|[/\\])/, homedir())),
          )
        : getAllowedIndexRoots();
    this.metadataFile = join(this.indexDir, "file_metadata.json");
    this.metadata = this._loadMetadata();
  }

  close(): void {
    // no-op — search uses sidecar JSON, no open retrievers
  }

  private _loadMetadata(): Record<string, FileMeta> {
    if (!existsSync(this.metadataFile)) return {};
    try {
      const data = JSON.parse(readFileSync(this.metadataFile, "utf8"));
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        console.error("File metadata is not an object; starting empty");
        return {};
      }
      return data as Record<string, FileMeta>;
    } catch (err) {
      const backup = `${this.metadataFile}.corrupt`;
      try {
        renameSync(this.metadataFile, backup);
        console.error(`Corrupt file metadata at ${this.metadataFile}; moved to ${backup}`);
      } catch {
        console.error(`Corrupt file metadata at ${this.metadataFile}:`, err);
      }
      return {};
    }
  }

  private _saveMetadata(): void {
    const tmp = `${this.metadataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.metadata), "utf8");
    renameSync(tmp, this.metadataFile);
  }

  private _computeFileHash(filePath: string): string {
    const hash = createHash("sha256");
    hash.update(readFileSync(filePath));
    return hash.digest("hex");
  }

  private _getFileType(filePath: string): string {
    return TYPE_MAP[extname(filePath).toLowerCase()] ?? "unknown";
  }

  private static validateChunking(
    chunkSize: number,
    overlap: number,
  ): { chunkSize: number; overlap: number } {
    if (!Number.isInteger(chunkSize)) throw new Error("chunk_size must be an integer");
    if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      throw new Error(
        `chunk_size must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`,
      );
    }
    if (!Number.isInteger(overlap) || overlap < 0) {
      throw new Error("overlap must be a non-negative integer");
    }
    if (overlap >= chunkSize) throw new Error("overlap must be smaller than chunk_size");
    return { chunkSize, overlap };
  }

  private _enforcePathPolicy(
    resolved: string,
    indexDotfiles: boolean,
    mustExistAs?: "file" | "dir",
  ): void {
    if (!isWithinAllowedRoots(resolved, this.allowedRoots)) {
      throw Object.assign(
        new Error(
          `Refusing to index path outside allowed roots: ${resolved}. ` +
            `Allowed roots: ${JSON.stringify(this.allowedRoots)}. ` +
            `Configure via REMEMBER_INDEX_ROOTS env var.`,
        ),
        { name: "PermissionError" },
      );
    }
    if (!indexDotfiles && isDotfilePath(resolved)) {
      throw Object.assign(
        new Error(
          `Refusing to index dotfile: ${resolved}. Pass index_dotfiles=True to override.`,
        ),
        { name: "PermissionError" },
      );
    }
    if (mustExistAs === "file") {
      try {
        if (!statSync(resolved).isFile()) {
          throw Object.assign(new Error(`File not found: ${resolved}`), {
            name: "FileNotFoundError",
          });
        }
      } catch (err) {
        if ((err as Error).name === "FileNotFoundError") throw err;
        throw Object.assign(new Error(`File not found: ${resolved}`), {
          name: "FileNotFoundError",
        });
      }
    }
    if (mustExistAs === "dir") {
      try {
        if (!statSync(resolved).isDirectory()) {
          throw Object.assign(new Error(`Directory not found: ${resolved}`), {
            name: "FileNotFoundError",
          });
        }
      } catch (err) {
        if ((err as Error).name === "FileNotFoundError") throw err;
        throw Object.assign(new Error(`Directory not found: ${resolved}`), {
          name: "FileNotFoundError",
        });
      }
    }
  }

  async indexFile(opts: {
    file_path: string;
    chunk_size?: number;
    overlap?: number;
    preserve_lines?: boolean;
    index_dotfiles?: boolean;
  }): Promise<Record<string, unknown>> {
    const { chunkSize, overlap } = FileIndexer.validateChunking(
      opts.chunk_size ?? 1024,
      opts.overlap ?? 128,
    );
    const preserveLines = opts.preserve_lines !== false;
    const indexDotfiles = opts.index_dotfiles === true;
    const resolved = resolve(
      opts.file_path.replace(/^~(?=$|[/\\])/, homedir()),
    );
    this._enforcePathPolicy(resolved, indexDotfiles, "file");

    const fileSize = statSync(resolved).size;
    if (fileSize > this.maxFileBytes) {
      throw Object.assign(
        new Error(
          `Refusing to index file larger than ${this.maxFileBytes} bytes: ${resolved} (${fileSize} bytes)`,
        ),
        { name: "PermissionError" },
      );
    }

    const fileHash = this._computeFileHash(resolved);
    const fileType = this._getFileType(resolved);
    const existing = this.metadata[fileHash];
    if (existing) {
      return {
        status: "already_indexed",
        file_path: existing.file_path ?? resolved,
        file_hash: fileHash,
        indexed_at: existing.indexed_at,
      };
    }

    if (fileType === "pdf" || fileType === "epub") {
      throw Object.assign(
        new Error(
          `PDF/EPUB indexing requires a dedicated parser; not yet ported in the Bun build (${resolved})`,
        ),
        { name: "ValueError" },
      );
    }

    const data = readFileSync(resolved);
    if (looksBinary(data.subarray(0, 8192))) {
      throw Object.assign(
        new Error(`Refusing to index binary file as text: ${resolved}`),
        { name: "PermissionError" },
      );
    }

    let content: string;
    try {
      content = data.toString("utf8");
    } catch {
      throw Object.assign(
        new Error(`Refusing to index non-UTF-8 file: ${resolved}`),
        { name: "PermissionError" },
      );
    }

    let chunks: string[];
    let chunksMeta: Array<Record<string, number>> = [];
    if (preserveLines && CODE_TYPES.has(fileType)) {
      const split = chunkCodeWithLines(content, basename(resolved), chunkSize);
      chunks = split.chunks;
      chunksMeta = split.meta;
    } else {
      chunks = chunkText(content, chunkSize, overlap);
    }

    if (chunks.length === 0) {
      throw new Error(`No indexable content in ${resolved}`);
    }

    const videoPath = join(this.indexDir, `${fileHash}.mp4`);
    const indexPath = join(this.indexDir, `${fileHash}.json`);
    const stats = await encodeChunks(chunks, videoPath, indexPath);
    return this._recordIndex({
      resolved,
      fileHash,
      fileType,
      fileSize,
      chunkCount: chunks.length,
      chunkSize,
      overlap,
      videoPath,
      indexPath,
      chunksMeta,
      stats,
    });
  }

  private _recordIndex(opts: {
    resolved: string;
    fileHash: string;
    fileType: string;
    fileSize: number;
    chunkCount: number;
    chunkSize: number;
    overlap: number;
    videoPath: string;
    indexPath: string;
    chunksMeta: Array<Record<string, number>>;
    stats: { video_size: number; compression_ratio: number };
  }): Record<string, unknown> {
    const metadata: FileMeta = {
      file_path: opts.resolved,
      file_name: basename(opts.resolved),
      file_hash: opts.fileHash,
      file_type: opts.fileType,
      file_size: opts.fileSize,
      chunk_count: opts.chunkCount,
      chunk_size: opts.chunkSize,
      overlap: opts.overlap,
      video_path: opts.videoPath,
      index_path: opts.indexPath,
      chunks_meta: opts.chunksMeta.length ? opts.chunksMeta : null,
      indexed_at: new Date().toISOString(),
      stats: opts.stats,
    };
    this.metadata[opts.fileHash] = metadata;
    this._saveMetadata();
    return {
      status: "indexed",
      file_path: opts.resolved,
      file_hash: opts.fileHash,
      chunk_count: opts.chunkCount,
      video_size: opts.stats.video_size,
      compression_ratio: opts.stats.compression_ratio,
    };
  }

  async indexDirectory(opts: {
    dir_path: string;
    pattern?: string;
    exclude?: string[] | null;
    chunk_size?: number;
    overlap?: number;
    index_dotfiles?: boolean;
  }): Promise<Record<string, unknown>> {
    const { chunkSize, overlap } = FileIndexer.validateChunking(
      opts.chunk_size ?? 1024,
      opts.overlap ?? 128,
    );
    const indexDotfiles = opts.index_dotfiles === true;
    const resolvedDir = resolve(
      opts.dir_path.replace(/^~(?=$|[/\\])/, homedir()),
    );
    this._enforcePathPolicy(resolvedDir, indexDotfiles, "dir");

    const excludePatterns = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])];
    const pattern = opts.pattern ?? "**/*";

    const glob = new Bun.Glob(pattern);
    const indexed: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let considered = 0;

    for await (const match of glob.scan({ cwd: resolvedDir, onlyFiles: true })) {
      const filePath = join(resolvedDir, match);
      let resolvedFile: string;
      try {
        resolvedFile = resolve(filePath);
      } catch (err) {
        errors.push({ file: filePath, error: String(err) });
        continue;
      }

      const rel = relative(resolvedDir, resolvedFile);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        skipped.push(filePath);
        continue;
      }

      if (excludePatterns.some((excl) => resolvedFile.includes(excl))) {
        skipped.push(filePath);
        continue;
      }
      if (!indexDotfiles && isDotfilePath(resolvedFile)) {
        skipped.push(filePath);
        continue;
      }

      considered += 1;
      if (considered > this.maxDirectoryFiles) {
        errors.push({
          file: resolvedDir,
          error: `Stopped after ${this.maxDirectoryFiles} files (max_directory_files). Narrow the glob or raise the cap.`,
        });
        break;
      }

      try {
        indexed.push(
          await this.indexFile({
            file_path: resolvedFile,
            chunk_size: chunkSize,
            overlap,
            index_dotfiles: indexDotfiles,
          }),
        );
      } catch (err) {
        errors.push({
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      indexed_count: indexed.length,
      skipped_count: skipped.length,
      error_count: errors.length,
      indexed_files: indexed,
      errors,
    };
  }

  search(opts: {
    query: string;
    top_k?: number;
    file_filter?: string | null;
    file_type_filter?: string | null;
  }): Record<string, unknown>[] {
    if (typeof opts.query !== "string" || !opts.query.trim()) {
      throw new Error("query must be a non-empty string");
    }
    const topK = opts.top_k ?? 10;
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_QUERY_K) {
      throw new Error(`top_k must be an integer between 1 and ${MAX_QUERY_K}`);
    }

    const results: Record<string, unknown>[] = [];
    for (const [fileHash, meta] of Object.entries(this.metadata)) {
      if (opts.file_filter && !String(meta.file_path).includes(opts.file_filter)) {
        continue;
      }
      if (opts.file_type_filter && meta.file_type !== opts.file_type_filter) continue;

      const videoPath = String(meta.video_path);
      const indexPath = String(meta.index_path);
      if (!existsSync(videoPath) || !existsSync(indexPath)) continue;

      try {
        const hits = searchSidecar(indexPath, opts.query, topK);
        for (const hit of hits) {
          const result: Record<string, unknown> = {
            content: hit.text,
            score: hit.score,
            file_path: meta.file_path,
            file_name: meta.file_name,
            file_type: meta.file_type,
            file_hash: fileHash,
            indexed_at: meta.indexed_at,
          };
          if (
            typeof hit.text === "string" &&
            hit.text.startsWith("[") &&
            hit.text.includes("]:")
          ) {
            result.line_info = hit.text.split("]", 1)[0] + "]";
          }
          results.push(result);
        }
      } catch (err) {
        console.error(`Error searching ${meta.file_path}:`, err);
      }
    }

    results.sort((a, b) => Number(b.score) - Number(a.score));
    return results.slice(0, topK);
  }

  getFileInfo(filePath: string): FileMeta | null {
    const resolved = filePath
      ? resolve(filePath.replace(/^~(?=$|[/\\])/, homedir()))
      : "";
    for (const meta of Object.values(this.metadata)) {
      if (meta.file_path === filePath || meta.file_path === resolved) return meta;
    }
    if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
      const fileHash = this._computeFileHash(resolved);
      if (fileHash in this.metadata) return this.metadata[fileHash]!;
    }
    return null;
  }

  listIndexedFiles(): Record<string, unknown>[] {
    return Object.values(this.metadata).map((meta) => ({
      file_path: meta.file_path,
      file_name: meta.file_name,
      file_type: meta.file_type,
      file_size: meta.file_size,
      chunk_count: meta.chunk_count,
      indexed_at: meta.indexed_at,
    }));
  }

  getStats(): Record<string, unknown> {
    const snapshot = Object.values(this.metadata);
    const totalFiles = snapshot.length;
    const totalChunks = snapshot.reduce((n, m) => n + Number(m.chunk_count || 0), 0);
    const totalSize = snapshot.reduce((n, m) => n + Number(m.file_size || 0), 0);
    let videoSize = 0;
    for (const meta of snapshot) {
      const videoPath = meta.video_path;
      if (typeof videoPath === "string" && existsSync(videoPath)) {
        try {
          videoSize += statSync(videoPath).size;
        } catch {
          // ignore
        }
      }
    }
    const fileTypes: Record<string, number> = {};
    for (const meta of snapshot) {
      const ft = String(meta.file_type || "unknown");
      fileTypes[ft] = (fileTypes[ft] ?? 0) + 1;
    }
    return {
      total_files: totalFiles,
      total_chunks: totalChunks,
      total_source_size: totalSize,
      total_video_size: videoSize,
      compression_ratio: videoSize > 0 ? totalSize / videoSize : 0,
      file_types: fileTypes,
    };
  }
}
