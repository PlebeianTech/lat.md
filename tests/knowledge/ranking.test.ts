import { describe, it, expect } from 'vitest';
import { tagsToTerms, capHits } from '../../src/knowledge/ranking.js';
import type { KnowledgeHit } from '../../src/knowledge/types.js';

describe('tagsToTerms', () => {
  it('preserves authored order, not alphabetical order', () => {
    // `run-pin` splits into `run`, `pin` (both length 3, both kept). With
    // maxTerms=2 the cut must take these two — the first tag the author
    // wrote — not "carry"/"param" (what sort -u would produce).
    expect(tagsToTerms(['run-pin', 'carry', 'query-param'])).toEqual([
      'run',
      'pin',
    ]);
  });

  it('drops words shorter than 3 characters', () => {
    expect(tagsToTerms(['a-bb-ccc'])).toEqual(['ccc']);
  });

  it('dedupes case-insensitively, keeping the first spelling', () => {
    expect(tagsToTerms(['Run', 'run', 'RUN-away'], 5)).toEqual(['Run', 'away']);
  });

  it('accepts a single string', () => {
    expect(tagsToTerms('run-pin')).toEqual(['run', 'pin']);
  });

  it('returns [] for non-array non-string input', () => {
    expect(tagsToTerms(42)).toEqual([]);
    expect(tagsToTerms(null)).toEqual([]);
    expect(tagsToTerms({ tags: ['run'] })).toEqual([]);
  });

  it('ignores non-string entries in an array', () => {
    expect(tagsToTerms(['run-pin', 42, null, 'carry'], 5)).toEqual([
      'run',
      'pin',
      'carry',
    ]);
  });

  it('respects maxTerms', () => {
    expect(tagsToTerms(['aaa', 'bbb', 'ccc'], 1)).toEqual(['aaa']);
    expect(tagsToTerms(['aaa', 'bbb', 'ccc'], 3)).toEqual([
      'aaa',
      'bbb',
      'ccc',
    ]);
  });

  it('defaults maxTerms to 2', () => {
    expect(tagsToTerms(['aaa', 'bbb', 'ccc'])).toEqual(['aaa', 'bbb']);
  });
});

describe('capHits', () => {
  function hit(store: 'cq', key: string, score: number): KnowledgeHit {
    return { store, key, title: key, detail: '', score };
  }

  it('sorts by score descending', () => {
    const hits = [hit('cq', 'a', 1), hit('cq', 'b', 3), hit('cq', 'c', 2)];
    expect(capHits(hits, 10).map((h) => h.key)).toEqual(['b', 'c', 'a']);
  });

  it('caps to the given limit', () => {
    const hits = [hit('cq', 'a', 1), hit('cq', 'b', 3), hit('cq', 'c', 2)];
    expect(capHits(hits, 2).map((h) => h.key)).toEqual(['b', 'c']);
  });

  it('is stable on ties: keeps input order among equal scores', () => {
    const hits = [
      hit('cq', 'a', 1),
      hit('cq', 'b', 1),
      hit('cq', 'c', 1),
      hit('cq', 'd', 2),
    ];
    expect(capHits(hits, 10).map((h) => h.key)).toEqual(['d', 'a', 'b', 'c']);
  });
});
