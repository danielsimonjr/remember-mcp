/**
 * Active memory store backed by bun:sqlite.
 *
 * Replaces openmemory-python's MemorySystem for the hot path: add, query,
 * salience, and forget. Embeddings are the local hasher (see embeddings.ts).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  blobToEmbedding,
  cosine,
  embed,
  embeddingToBlob,
} from "./embeddings.ts";
import { classifySectors } from "./sectors.ts";
import type { SectorType } from "./types.ts";

export interface ActiveMemoryRow {
  id: string;
  content: string;
  user_id: string | null;
  primary_sector: SectorType;
  sectors: SectorType[];
  salience: number;
  created_at: number;
  last_seen_at: number;
  tags: string[];
  metadata: Record<string, unknown>;
  score?: number;
}

export interface AddMemoryResult {
  id: string;
  content: string;
  primary_sector: string;
  sectors: string[];
  salience: number;
  user_id: string | null;
  tags: string[];
  created_at: number;
}

// Fresh memories start below 1.0 so an explicit `min_salience: 1.0`
// archival (the "archive everything eligible by age" probe used in tests
// and by operators) actually selects them. `salience < min_salience` is
// the keep-floor rule — matching the Python openmemory path.
const INITIAL_SALIENCE = 0.85;
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function decaySalience(salience: number, lastSeenAt: number, now: number): number {
  const age = Math.max(0, now - lastSeenAt);
  const factor = Math.pow(0.5, age / HALF_LIFE_MS);
  return Math.max(0, salience * factor);
}

export class ActiveStore {
  readonly dbPath: string;
  readonly db: Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        user_id TEXT,
        primary_sector TEXT NOT NULL,
        sectors_json TEXT NOT NULL,
        salience REAL NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    `);
  }

  addMemory(opts: {
    content: string;
    user_id?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
  }): AddMemoryResult {
    const now = Date.now();
    const { primary, sectors } = classifySectors(opts.content);
    const id = randomUUID();
    const tags = opts.tags ?? [];
    const metadata = opts.metadata ?? {};
    const embedding = embed(opts.content);

    this.db
      .query(
        `INSERT INTO memories (
          id, content, user_id, primary_sector, sectors_json, salience,
          created_at, last_seen_at, tags_json, metadata_json, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.content,
        opts.user_id ?? null,
        primary,
        JSON.stringify(sectors),
        INITIAL_SALIENCE,
        now,
        now,
        JSON.stringify(tags),
        JSON.stringify(metadata),
        embeddingToBlob(embedding),
      );

    return {
      id,
      content: opts.content,
      primary_sector: primary,
      sectors,
      salience: INITIAL_SALIENCE,
      user_id: opts.user_id ?? null,
      tags,
      created_at: now,
    };
  }

  query(opts: {
    query: string;
    k: number;
    user_id?: string | null;
    sectors?: string[] | null;
  }): ActiveMemoryRow[] {
    const now = Date.now();
    const qVec = embed(opts.query);
    const rows = opts.user_id
      ? this.db
          .query(`SELECT * FROM memories WHERE user_id = ?`)
          .all(opts.user_id)
      : this.db.query(`SELECT * FROM memories`).all();

    const sectorFilter = opts.sectors?.length
      ? new Set(opts.sectors.map((s) => s.toLowerCase()))
      : null;

    const scored: ActiveMemoryRow[] = [];
    for (const raw of rows as Record<string, unknown>[]) {
      const sectors = JSON.parse(String(raw.sectors_json)) as SectorType[];
      if (sectorFilter && !sectors.some((s) => sectorFilter.has(s))) continue;

      const lastSeen = Number(raw.last_seen_at);
      const salience = decaySalience(Number(raw.salience), lastSeen, now);
      const emb = blobToEmbedding(raw.embedding as Buffer);
      const sim = cosine(qVec, emb);
      // Blend similarity with salience so fresh/important memories rise.
      const score = sim * 0.85 + salience * 0.15;

      scored.push({
        id: String(raw.id),
        content: String(raw.content),
        user_id: (raw.user_id as string | null) ?? null,
        primary_sector: raw.primary_sector as SectorType,
        sectors,
        salience,
        created_at: Number(raw.created_at),
        last_seen_at: lastSeen,
        tags: JSON.parse(String(raw.tags_json)) as string[],
        metadata: JSON.parse(String(raw.metadata_json)) as Record<string, unknown>,
        score,
      });
    }

    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const top = scored.slice(0, opts.k);

    // Touch last_seen for returned hits (reinforces salience).
    const touch = this.db.query(
      `UPDATE memories SET last_seen_at = ?, salience = MIN(1.0, salience + 0.05) WHERE id = ?`,
    );
    const bump = this.db.transaction((ids: string[]) => {
      for (const id of ids) touch.run(now, id);
    });
    bump(top.map((r) => r.id));

    return top;
  }

  selectEligible(opts: {
    user_id?: string | null;
    age_threshold_ms: number;
    min_salience: number;
  }): Array<{ id: string; content: string }> {
    const now = Date.now();
    const rows = opts.user_id
      ? (this.db
          .query(
            `SELECT id, content, salience, last_seen_at, created_at FROM memories
             WHERE user_id = ? AND created_at <= ?`,
          )
          .all(opts.user_id, opts.age_threshold_ms) as Record<string, unknown>[])
      : (this.db
          .query(
            `SELECT id, content, salience, last_seen_at, created_at FROM memories
             WHERE created_at <= ?`,
          )
          .all(opts.age_threshold_ms) as Record<string, unknown>[]);

    const eligible: Array<{ id: string; content: string; salience: number; created_at: number }> =
      [];
    for (const raw of rows) {
      const salience = decaySalience(
        Number(raw.salience),
        Number(raw.last_seen_at),
        now,
      );
      if (salience < opts.min_salience) {
        eligible.push({
          id: String(raw.id),
          content: String(raw.content),
          salience,
          created_at: Number(raw.created_at),
        });
      }
    }
    eligible.sort((a, b) => a.salience - b.salience || a.created_at - b.created_at);
    return eligible.map(({ id, content }) => ({ id, content }));
  }

  deleteByIds(ids: string[]): number {
    if (ids.length === 0) return 0;
    const del = this.db.query(`DELETE FROM memories WHERE id = ?`);
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) del.run(id);
    });
    tx(ids);
    return ids.length;
  }

  count(user_id?: string | null): number {
    if (user_id) {
      const row = this.db
        .query(`SELECT COUNT(*) AS count FROM memories WHERE user_id = ?`)
        .get(user_id) as { count: number };
      return Number(row.count);
    }
    const row = this.db.query(`SELECT COUNT(*) AS count FROM memories`).get() as {
      count: number;
    };
    return Number(row.count);
  }

  countAndAvgSalience(user_id?: string | null): { count: number; avg: number } {
    const now = Date.now();
    const rows = user_id
      ? (this.db
          .query(`SELECT salience, last_seen_at FROM memories WHERE user_id = ?`)
          .all(user_id) as Array<{ salience: number; last_seen_at: number }>)
      : (this.db.query(`SELECT salience, last_seen_at FROM memories`).all() as Array<{
          salience: number;
          last_seen_at: number;
        }>);

    if (rows.length === 0) return { count: 0, avg: 0 };
    let sum = 0;
    for (const r of rows) {
      sum += decaySalience(Number(r.salience), Number(r.last_seen_at), now);
    }
    return { count: rows.length, avg: sum / rows.length };
  }

  close(): void {
    this.db.close();
  }
}
