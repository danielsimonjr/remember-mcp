import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSidecar } from "../src/remember/archive.ts";
import { cosine, currentVector, embed, embeddingToBlob } from "../src/remember/embeddings.ts";
import { RememberSystem } from "../src/remember/system.ts";

const nonZero = (vec: Float32Array) => vec.filter((x) => x !== 0).length;
const norm = (vec: Float32Array) => Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
const sim = (a: string, b: string) => cosine(embed(a), embed(b));
const digest = (vec: Float32Array) =>
  createHash("sha256").update(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)).digest("hex").slice(0, 16);

// The vector of each text, as the first version of embed() made it: the first 16 hex digits of the sha256 of its bytes.
const FIRST_VERSION: Array<[string, string]> = [
  ["hello world", "8b76d9ae5a501e8d"],
  ["Deploy key rotation runbook, step_1 of 12", "1ff9e95aaeec7132"],
  ["alpha alpha beta", "3bc526a34d88d1f3"],
  ["x y z a1 b_2 __init__ 007 0x1F", "d29866f2524f56c8"],
  ["The quick brown fox jumps over the lazy dog. The DOG barks; the fox runs away!", "23d66420f62ab5ab"],
  ["", "373421642a44f741"],
  ["a b c", "373421642a44f741"],
  ["token ".repeat(500) + "other", "b607abe8c6a6db4e"],
  ["UPPER lower MiXeD CaSe words", "4c2b9d3f3ba7f491"],
  ["foo-bar_baz.qux/quux:corge=grault", "b9f48acb15b61e73"],
];

describe("embed", () => {
  test("ASCII text keeps the vector it always had", () => {
    const hello = embed("hello world");
    expect(nonZero(hello)).toBe(2);
    expect(hello[175]).toBeCloseTo(0.707107, 5);
    expect(hello[342]).toBeCloseTo(0.707107, 5);

    const mixed = embed("Deploy key rotation runbook, step_1 of 12");
    expect(nonZero(mixed)).toBe(7);
    expect(mixed[149]).toBeCloseTo(-0.377964, 5);
    expect(mixed[335]).toBeCloseTo(0.377964, 5);

    const repeated = embed("alpha alpha beta");
    expect(nonZero(repeated)).toBe(2);
    expect(repeated[68]).toBeCloseTo(0.927386, 5);
    expect(repeated[295]).toBeCloseTo(-0.374105, 5);
  });

  test("ASCII text gives the same bytes as the first version, for a spread of texts", () => {
    for (const [text, expected] of FIRST_VERSION) {
      expect(digest(embed(text))).toBe(expected);
    }
  });

  test("a text with no token still gets the fallback vector", () => {
    for (const text of ["a b c", "!!! ???", "😀😀"]) {
      const vec = embed(text);
      expect(vec[0]).toBe(1);
      expect(nonZero(vec)).toBe(1);
    }
  });

  test("two different Chinese sentences are not the same vector", () => {
    expect(sim("我喜欢吃苹果", "今天天气很好")).toBeLessThan(0.5);
  });

  test("Chinese sentences that share words are closer than sentences that share none", () => {
    const apple = "我喜欢吃苹果";
    expect(sim(apple, "我喜欢吃香蕉")).toBeGreaterThan(sim(apple, "今天天气很好"));
    expect(sim(apple, "我喜欢吃香蕉")).toBeGreaterThan(0.5);
  });

  test("Japanese kana and kanji share a word", () => {
    const shared = sim("こんにちは世界", "さようなら世界");
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThan(1);
    expect(shared).toBeGreaterThan(sim("こんにちは世界", "コンピューターの本"));
  });

  test("Katakana words that differ by a long vowel mark share pairs but are not equal", () => {
    const shared = sim("コンピューター", "コンピュータ");
    expect(shared).toBeGreaterThan(0.5);
    expect(shared).toBeLessThan(1);
  });

  test("a Katakana long vowel mark joins its neighbour into one pair", () => {
    expect(sim("アー", "ア")).toBeLessThan(0.5);
  });

  test("Hiragana is read in pairs of characters", () => {
    const shared = sim("こんにちは", "こんばんは");
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThan(1);
  });

  test("a combining mark stays inside its word", () => {
    expect(sim("की", "के")).toBeLessThan(1);
  });

  test("a single letter of any script is noise, as it is in ASCII", () => {
    expect(sim("é", "a b c")).toBeCloseTo(1, 5);
    expect(sim("я", "a b c")).toBeCloseTo(1, 5);
    // U+1D49C is one letter that takes two UTF-16 units.
    expect(sim(String.fromCodePoint(0x1d49c), "a b c")).toBeCloseTo(1, 5);
    expect(sim(String.fromCodePoint(0x1d49c, 0x1d49e), "a b c")).toBeLessThan(0.5);
  });

  test("a letter with its accent and the same letter with a separate accent mark give one vector", () => {
    expect(sim("café au lait", "café au lait")).toBeCloseTo(1, 5);
    expect(sim("がっこう", "がっこう")).toBeCloseTo(1, 5);
  });

  test("words of a script with spaces are tokens", () => {
    expect(sim("привет мир", "привет друг")).toBeGreaterThan(sim("привет мир", "добрый вечер"));
    expect(sim("Καλημέρα κόσμε", "Καλημέρα φίλε")).toBeGreaterThan(sim("Καλημέρα κόσμε", "ευχαριστώ πολύ"));
  });

  test("Thai, which has no space between words, is read in pairs of characters", () => {
    expect(sim("สวัสดีครับ", "สวัสดีค่ะ")).toBeGreaterThan(sim("สวัสดีครับ", "ขอบคุณมาก"));
  });

  test("Korean words are tokens", () => {
    expect(sim("안녕하세요 세계", "안녕하세요 친구")).toBeGreaterThan(sim("안녕하세요 세계", "감사합니다 여러분"));
  });

  test("a single character of an unspaced script is a token, not the fallback vector", () => {
    expect(sim("猫", "狗")).toBeLessThan(1);
    expect(sim("猫", "a b c")).toBeLessThan(1);
  });

  test("ASCII words and unspaced script joined without a space both count", () => {
    expect(sim("Bun运行时", "运行时")).toBeGreaterThan(0);
    expect(sim("Bun运行时", "bun")).toBeGreaterThan(0);
  });

  test("a word of a script with case folds to lower case", () => {
    expect(sim("ПРИВЕТ МИР", "привет мир")).toBeCloseTo(1, 5);
    expect(sim("ПРИВЕТ МИР", "добрый вечер")).toBeLessThan(0.5);
  });

  test("vectors have unit length", () => {
    expect(norm(embed("我喜欢吃苹果 and apples, привет"))).toBeCloseTo(1, 5);
  });

  test("a text of the longest allowed length embeds in linear time", () => {
    // MAX_CONTENT_CHARS is 100_000 and each character adds a token, so a count by a scan per token takes far longer than the limit.
    const text = "我喜欢吃苹果".repeat(16_666);
    const started = Date.now();
    expect(norm(embed(text))).toBeCloseTo(1, 5);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("currentVector", () => {
  test("a stored vector that is not the fallback vector is returned as it is", () => {
    const stored = embed("hello world");
    expect(currentVector(stored, "我喜欢吃苹果")).toBe(stored);
  });

  test("the fallback vector of a text that has tokens now is made again", () => {
    const text = "我喜欢吃苹果";
    const repaired = currentVector(embed(""), text);
    expect(repaired[0]).not.toBe(1);
    expect(cosine(repaired, embed(text))).toBeCloseTo(1, 5);
  });

  test("the fallback vector of a text that has no token stays the fallback vector", () => {
    const repaired = currentVector(embed(""), "a b c");
    expect(repaired[0]).toBe(1);
    expect(nonZero(repaired)).toBe(1);
  });

  test("a vector with 1 in slot 0 and other slots set is not the fallback vector", () => {
    const stored = new Float32Array(384);
    stored[0] = 1;
    stored[5] = 0.25;
    expect(currentVector(stored, "我喜欢吃苹果")).toBe(stored);
  });
});

describe("query over memories in a script without spaces", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "remember-embed-"));
    dirs.push(dir);
    return dir;
  }

  function makeSystem(dir: string): RememberSystem {
    return new RememberSystem({
      active_db: join(dir, "active.db"),
      archive_dir: join(dir, "archives") + "/",
      archive_threshold_days: 0,
      archive_min_salience: 1.0,
      auto_archive_enabled: false,
    });
  }

  // The target is the middle memory. On the first version every memory had the same vector, so the tie went to the
  // newest memory by salience, or to the first when the three were added in one millisecond. The middle one never won.
  const MEMORIES = ["今天天气很好适合出去散步", "服务器证书每九十天轮换一次", "我喜欢吃苹果和香蕉"];

  test("the memory that shares the words of the query comes first, and by a clear margin", async () => {
    const s = makeSystem(makeDir());
    try {
      for (const content of MEMORIES) await s.addMemory({ content });
      const hits = await s.query({ query: "证书轮换", k: 3, include_archive: false });
      expect(hits[0]?.content).toBe(MEMORIES[1]!);
      expect(hits[0]!.score - hits[1]!.score).toBeGreaterThan(0.1);
    } finally {
      s.close();
    }
  }, 120_000);

  test("a row that an older version stored with the fallback vector is still found", async () => {
    const dir = makeDir();
    const s = makeSystem(dir);
    try {
      for (const content of MEMORIES) await s.addMemory({ content });
      // Put back what the first version wrote for these rows.
      const db = new Database(join(dir, "active.db"));
      db.query("UPDATE memories SET embedding = ?").run(embeddingToBlob(embed("")));
      db.close();

      const hits = await s.query({ query: "证书轮换", k: 3, include_archive: false });
      expect(hits[0]?.content).toBe(MEMORIES[1]!);
      expect(hits[0]!.score - hits[1]!.score).toBeGreaterThan(0.1);
    } finally {
      s.close();
    }
  }, 120_000);

  test("a chunk that an older version stored with the fallback vector is still found", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    const sidecar = join(dir, "old.json");
    const old = Array.from(embed(""));
    writeFileSync(
      sidecar,
      JSON.stringify({
        version: 1,
        created_at: 0,
        total_chunks: 3,
        chunks: MEMORIES.map((text) => ({ text, embedding: old })),
      }),
      "utf8",
    );
    const hits = searchSidecar(sidecar, "证书轮换", 3);
    expect(hits[0]?.text).toBe(MEMORIES[1]!);
    expect(hits[0]!.score - hits[1]!.score).toBeGreaterThan(0.1);
  });
});
