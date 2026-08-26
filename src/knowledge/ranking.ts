import type { KnowledgeHit } from './types.js';

// Runs of anything that is not an ASCII/Unicode letter or digit. This is a
// splitter, not a validator, so it stays permissive about what counts as a
// "word" — the length-3 filter below does the real filtering.
const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * Turn a frontmatter `tags:` value into search terms.
 *
 * Two terms by default: each store call costs a subprocess or a query, and
 * two terms is the least that still lets matched-term-count ranking mean
 * anything (a hit that matched both terms outranks one that matched one).
 */
export function tagsToTerms(value: unknown, maxTerms = 2): string[] {
  let tags: string[];
  if (typeof value === 'string') {
    tags = [value];
  } else if (Array.isArray(value)) {
    tags = value.filter((v): v is string => typeof v === 'string');
  } else {
    return [];
  }

  const seenLower = new Set<string>();
  const terms: string[] = [];

  // One term per tag, taken BEFORE the maxTerms cap is applied. A single
  // hyphenated tag splits into several words; if the cap were applied to
  // that per-word list, one tag could exhaust the whole budget and starve
  // every other authored tag (see the worked example above the cap).
  // Picking one representative word per tag first means the cap trims
  // across tags instead of within one.
  for (const tag of tags) {
    const words = tag.split(WORD_BREAK).filter((w) => w.length >= 3);
    if (words.length === 0) continue;
    const word = words[0];
    const lower = word.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    terms.push(word);
  }

  // NEVER sort. Tags are search terms the author chose and ordered; the shell
  // implementation piped them through `sort -u` for the dedupe and the sort
  // silently reordered them too, so cutting to maxTerms took the two
  // alphabetically-first fragments instead of the two the author actually
  // wrote first. `tags: [run-pin, carry, query-param]` searched "carry" and
  // "param" and dropped the primary tag entirely. Authored order must survive
  // to the slice below.
  return terms.slice(0, maxTerms);
}

/**
 * Stable sort by score, descending, then cap. Scores are only ever compared
 * within one store's hits — a store that cannot attribute a match to
 * individual terms and reports one flat score should never be capped
 * alongside a store that scores per-term, so callers must call this once per
 * store's hit list, not once over a merged list.
 */
export function capHits(hits: KnowledgeHit[], limit: number): KnowledgeHit[] {
  // Array#sort is stable per spec (Node/V8 for years now), so ties keep
  // their input order without any extra bookkeeping.
  return [...hits].sort((a, b) => b.score - a.score).slice(0, limit);
}
