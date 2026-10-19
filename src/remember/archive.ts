/**
 * QR-video archive helpers (TypeScript memvid stand-in).
 *
 * Each chunk becomes one or more QR frames; ffmpeg packs the frames into an MP4.
 * Search uses the JSON sidecar's hashed embeddings — not FAISS — so cold
 * start stays cheap. The MP4 remains the durable, portable payload.
 */

import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import QRCode from "qrcode";
import { cosine, embed } from "./embeddings.ts";
import { ensureDir } from "./ensure-dir.ts";

/**
 * One archived text chunk with its embedding.
 */
export interface ArchiveChunk {
  text: string;
  embedding: number[];
}

/**
 * The JSON sidecar of an archive video.
 * It holds every chunk with its embedding, so a search does not decode the video.
 */
export interface ArchiveSidecar {
  version: 1;
  chunks: ArchiveChunk[];
  created_at: number;
  total_chunks: number;
}

/**
 * The video size, the chunk count and the compression ratio that `encodeChunks` measured.
 */
export interface EncodeResult {
  video_size: number;
  chunk_count: number;
  compression_ratio: number;
}

// A QR frame at error correction level M holds 2331 bytes. A budget of 800 UTF-8 bytes
// leaves a wide margin for text of any width, and ASCII text keeps frames of 800 characters.
const QR_FRAME_BYTES = 800;

// Cut the text into slices of at most QR_FRAME_BYTES UTF-8 bytes. A cut falls between two
// code points, never inside a surrogate pair, because the QR library throws on a lone surrogate.
function splitForQr(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > QR_FRAME_BYTES) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += char;
    bytes += size;
  }
  parts.push(part);
  return parts;
}

function writeSidecar(indexPath: string, chunks: string[]): ArchiveSidecar {
  const sidecar: ArchiveSidecar = {
    version: 1,
    created_at: Date.now(),
    total_chunks: chunks.length,
    chunks: chunks.map((text) => ({
      text,
      embedding: Array.from(embed(text)),
    })),
  };
  ensureDir(dirname(indexPath));
  const tmp = `${indexPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(sidecar), "utf8");
  renameSync(tmp, indexPath);
  return sidecar;
}

async function writeQrFrames(chunks: string[], frameDir: string): Promise<number> {
  let frame = 0;
  for (const chunk of chunks) {
    for (const part of splitForQr(chunk)) {
      const file = join(frameDir, `frame_${String(frame).padStart(6, "0")}.png`);
      await QRCode.toFile(file, part, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 512,
        type: "png",
      });
      frame += 1;
    }
  }
  return frame;
}

function runFfmpeg(frameDir: string, videoPath: string, frameCount: number): void {
  ensureDir(dirname(videoPath));
  // Constant frame rate; even a single frame still produces a valid MP4.
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "2",
    "-i",
    join(frameDir, "frame_%06d.png"),
    "-frames:v",
    String(Math.max(1, frameCount)),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    videoPath,
  ];
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "ffmpeg failed").trim();
    throw new Error(`ffmpeg encode failed: ${err}`);
  }
}

/**
 * Delete the video, the sidecar and the temporary or older index files of one archive.
 * The function ignores a file that it cannot delete.
 */
export function removeArchiveOutputs(videoPath: string, indexPath: string): void {
  for (const path of [
    videoPath,
    indexPath,
    `${indexPath}.tmp`,
    videoPath.replace(/\.mp4$/i, ".json"),
    videoPath.replace(/\.mp4$/i, ".faiss"),
  ]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Write the chunks as QR frames, pack the frames into an MP4 with `ffmpeg`, and write the JSON sidecar.
 * The function throws when `chunks` is empty or when `ffmpeg` fails. After a failure, it deletes the outputs.
 */
export async function encodeChunks(
  chunks: Iterable<string>,
  videoPath: string,
  indexPath: string,
): Promise<EncodeResult> {
  const chunkList = [...chunks];
  if (chunkList.length === 0) throw new Error("No chunks to encode");

  const frameDir = mkdtempSync(join(tmpdir(), "remember-frames-"));
  try {
    writeSidecar(indexPath, chunkList);
    const frameCount = await writeQrFrames(chunkList, frameDir);
    runFfmpeg(frameDir, videoPath, frameCount);

    const videoSize = existsSync(videoPath) ? statSync(videoPath).size : 0;
    const originalSize = chunkList.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
    return {
      video_size: videoSize,
      chunk_count: chunkList.length,
      compression_ratio: videoSize > 0 ? originalSize / videoSize : 1,
    };
  } catch (err) {
    removeArchiveOutputs(videoPath, indexPath);
    throw err;
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

/**
 * Read an archive sidecar.
 * Returns null when the file is missing or is not a valid sidecar.
 */
export function loadSidecar(indexPath: string): ArchiveSidecar | null {
  const candidates = [
    indexPath,
    indexPath.replace(/\.json$/i, "") + ".json",
  ];
  for (const path of candidates) {
    if (!existsSync(path) || !path.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as ArchiveSidecar;
      if (data && Array.isArray(data.chunks)) return data;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Count the chunks of a sidecar. Returns 0 when the sidecar cannot be read.
 */
export function sidecarChunkCount(indexPath: string): number {
  const data = loadSidecar(indexPath);
  if (!data) return 0;
  return data.total_chunks || data.chunks.length || 0;
}

/**
 * Rank the chunks of a sidecar by cosine similarity to `query`.
 * Returns the best `topK` chunks, or an empty list when the sidecar cannot be read or holds no chunk.
 */
export function searchSidecar(
  indexPath: string,
  query: string,
  topK: number,
): Array<{ text: string; score: number }> {
  const data = loadSidecar(indexPath);
  if (!data || data.chunks.length === 0) return [];
  const q = embed(query);
  const scored = data.chunks.map((chunk) => {
    const emb = Float32Array.from(chunk.embedding);
    return { text: chunk.text, score: cosine(q, emb) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
