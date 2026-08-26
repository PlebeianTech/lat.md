import { describe, it, expect } from 'vitest';
import { tagsToTerms, capHits } from '../../src/knowledge/ranking.js';
import type { KnowledgeHit } from '../../src/knowledge/types.js';

describe('tagsToTerms', () => {
  it('preserves authored order, not alphabetical order', () => {
    // One term per tag, taken before the maxTerms cap. With maxTerms=2 the
    // cut must take the first two authored tags' terms ('run', 'carry') —
    // not "carry"/"param" (what sort -u would produce) and not both halves
    // of 'run-pin' (which would starve 'carry' and 'query-param' entirely).
    expect(tagsToTerms(['run-pin', 'carry', 'query-param'])).toEqual([
      'run',
      'carry',
    ]);
  });

  // @lat: [[knowledge-store#tagsToTerms: term budget per tag#Reaches more than one authored tag with a hyphenated first tag]]
  it('reaches more than one authored tag with a hyphenated first tag', () => {
    // Regression: a single hyphenated tag must not consume the whole term
    // budget and starve every other tag.
    const terms = tagsToTerms(['run-pin', 'carry', 'query-param']);
    expect(terms.length).toBeGreaterThan(1);
  });

  it('drops words shorter than 3 characters within a tag', () => {
    expect(tagsToTerms(['a-bb-ccc'])).toEqual(['ccc']);
  });

  // @lat: [[knowledge-store#tagsToTerms: term budget per tag#Takes only the first qualifying word of a hyphenated tag]]
  it('takes only the first qualifying word of a hyphenated tag', () => {
    expect(tagsToTerms(['RUN-away'], 5)).toEqual(['RUN']);
  });

  it('dedupes case-insensitively, keeping the first spelling', () => {
    expect(tagsToTerms(['Run', 'run', 'RUN-away'], 5)).toEqual(['Run']);
  });

  it('accepts a single string', () => {
    expect(tagsToTerms('run-pin')).toEqual(['run']);
  });

  it('returns [] for non-array non-string input', () => {
    expect(tagsToTerms(42)).toEqual([]);
    expect(tagsToTerms(null)).toEqual([]);
    expect(tagsToTerms({ tags: ['run'] })).toEqual([]);
  });

  it('ignores non-string entries in an array', () => {
    expect(tagsToTerms(['run-pin', 42, null, 'carry'], 5)).toEqual([
      'run',
      'carry',
    ]);
  });

  // @lat: [[knowledge-store#tagsToTerms: term budget per tag#Keeps a non-ASCII tag instead of dropping it]]
  it('keeps a non-ASCII tag instead of dropping it', () => {
    expect(tagsToTerms(['café-pin'])).toEqual(['café']);
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
