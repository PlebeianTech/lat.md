// The contract every knowledge store implements. This file is the integration
// point between the three store modules and the federation entry point, so it
// is deliberately the only file in src/knowledge/ that none of them owns.
//
// The governing rule for the whole directory: a store is OPTIONAL. Absent
// binary, absent database, absent directory, malformed row, non-zero exit,
// timeout — every one of those is an empty result, never a thrown error and
// never a message on stderr. `lat hook` must not fail a user's prompt because
// a lookup that was never guaranteed to find anything found nothing.

export type StoreName = 'cq' | 'bd' | 'claude-memory';

/** One result from one store. Text is RAW here — the caller quotes it. */
export type KnowledgeHit = {
  store: StoreName;
  /**
   * Stable identity, used for dedupe and for match counting: a bd memory key,
   * an absolute memory-file path, a cq row identity. Never shown to a reader.
   */
  key: string;
  /** Short label shown first. A bd key, a memory `name:`, a cq summary. */
  title: string;
  /** Longer text shown after the title. May be empty. */
  detail: string;
  /**
   * How many query terms matched this hit. Higher sorts first. A store that
   * ranks internally (cq, by bm25) reports the number of terms it was given.
   */
  score: number;
};

/** Everything a store needs for one lookup. */
export type StoreQuery = {
  /**
   * Search terms in the order the author wrote the tags. NEVER re-sort this
   * array: the order is the author's ranking of the terms, and sorting makes
   * the primary tag lose to an alphabetical accident.
   */
  terms: string[];
  /** Absolute path to the project root (the parent of lat.md/). */
  projectRoot: string;
  /** Most hits this store may return for this one query. */
  limit: number;
};

/**
 * A knowledge store. `query` resolves to [] when the store is unavailable for
 * any reason. It must never throw and must never write to stdout or stderr.
 */
export type Store = {
  name: StoreName;
  query(q: StoreQuery): Promise<KnowledgeHit[]>;
};

/** A lat.md document that carries `lat: { tags: [...] }` in its frontmatter. */
export type TaggedDoc = {
  /** Section or document id, used as the dedupe key and as the block heading. */
  id: string;
  /** Tags exactly as authored, in the authored order. */
  tags: string[];
};
