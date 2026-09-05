/**
 * QR-video archive helpers (TypeScript memvid stand-in).
 *
 * Each chunk becomes a QR frame; ffmpeg packs the frames into an MP4.
 * Search uses the JSON sidecar's hashed embeddings — not FAISS — so cold
 * start stays cheap. The MP4 remains the durable, portable payload.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import QRCode from "qrcode";
import { cosine, embed } from "./embeddings.ts";

export interface ArchiveChunk {
  text: string;
  embedding: number[];
}

export interface ArchiveSidecar {
  version: 1;
  chunks: ArchiveChunk[];
  created_at: number;
  total_chunks: number;
}

export interface EncodeResult {
  video_size: number;
  chunk_count: number;
  compression_ratio: number;
}

const QR_CAPACITY = 800; // conservative byte budget per frame (alphanumeric-ish)

function splitForQr(text: string): string[] {
  if (text.length <= QR_CAPACITY) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += QR_CAPACITY) {
    parts.push(text.slice(i, i + QR_CAPACITY));
  }
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
  mkdirSync(dirname(indexPath), { recursive: true });
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
  mkdirSync(dirname(videoPath), { recursive: true });
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

export function sidecarChunkCount(indexPath: string): number {
  const data = loadSidecar(indexPath);
  if (!data) return 0;
  return data.total_chunks || data.chunks.length || 0;
}

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
