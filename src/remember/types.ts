/** Where a memory is stored. */
export enum MemoryLocation {
  ACTIVE = "active",
  ARCHIVE = "archive",
}

/** Cognitive sector labels (OpenMemory-compatible). */
export type SectorType =
  | "episodic"
  | "semantic"
  | "procedural"
  | "emotional"
  | "reflective";

export const SECTORS: readonly SectorType[] = [
  "episodic",
  "semantic",
  "procedural",
  "emotional",
  "reflective",
] as const;

/** Query result with location info. */
export interface HybridMemoryResult {
  id: string;
  content: string;
  score: number;
  location: MemoryLocation;
  sectors: string[];
  primary_sector: string;
  salience: number;
  last_seen_at: number;
  archived_at?: number | null;
  archive_file?: string | null;
}

/** Archive operation statistics. */
export interface ArchiveStats {
  archived_count: number;
  active_remaining: number;
  archive_size_bytes: number;
  compression_ratio: number;
}

/**
 * Overall system statistics.
 *
 * `archive_count` is the number of *memories* in archive storage, not the
 * number of video files. `archive_file_count` is the file tally.
 */
export interface SystemStats {
  active_count: number;
  archive_count: number;
  total_memories: number;
  active_db_size: number;
  archive_size: number;
  total_size: number;
  compression_ratio: number;
  avg_salience: number;
  archive_file_count: number;
}

export interface ArchiveInfo {
  file: string;
  index: string;
  created_at: number;
  memory_count: number;
}

export type ArchiveIndex = Record<string, Record<string, ArchiveInfo>>;
