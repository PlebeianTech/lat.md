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

  for (const tag of tags) {
    for (const word of tag.split(WORD_BREAK)) {
      if (word.length < 3) continue;
      const lower = word.toLowerCase();
      if (seenLower.has(lower)) continue;
      seenLower.add(lower);
      terms.push(word);
    }
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
