/**
 * Keyword-heuristic sector classifier.
 *
 * Replaces openmemory's embedding-based classifier. Good enough for routing
 * memories into the five cognitive sectors without a model download.
 */

import { SECTORS, type SectorType } from "./types.ts";

const KEYWORDS: Record<SectorType, string[]> = {
  episodic: [
    "yesterday",
    "today",
    "last week",
    "meeting",
    "discussed",
    "happened",
    "remember when",
    "earlier",
    "this morning",
    "event",
  ],
  semantic: [
    "is a",
    "are a",
    "means",
    "definition",
    "prefer",
    "fact",
    "know that",
    "concept",
    "language",
    "framework",
  ],
  procedural: [
    "how to",
    "run:",
    "steps",
    "deploy",
    "install",
    "procedure",
    "command",
    "workflow",
    "build",
    "configure",
  ],
  emotional: [
    "feel",
    "excited",
    "happy",
    "sad",
    "anxious",
    "love",
    "hate",
    "worried",
    "proud",
    "frustrated",
  ],
  reflective: [
    "insight",
    "lesson",
    "realize",
    "wisdom",
    "reflection",
    "principle",
    "simplicity",
    "learned that",
    "key takeaway",
    "in hindsight",
  ],
};

export function classifySectors(content: string): {
  primary: SectorType;
  sectors: SectorType[];
} {
  const lower = content.toLowerCase();
  const scores = new Map<SectorType, number>();

  for (const sector of SECTORS) {
    let score = 0;
    for (const kw of KEYWORDS[sector]) {
      if (lower.includes(kw)) score += 1;
    }
    scores.set(sector, score);
  }

  const ranked = [...SECTORS].sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
  );
  const top = ranked[0]!;
  const topScore = scores.get(top) ?? 0;
  const primary: SectorType = topScore > 0 ? top : "semantic";
  const sectors: SectorType[] = [primary];
  for (const s of ranked.slice(1)) {
    if ((scores.get(s) ?? 0) > 0 && sectors.length < 3) sectors.push(s);
  }
  return { primary, sectors };
}
