import { spawnSync } from 'node:child_process';
import type { Store, StoreQuery, KnowledgeHit } from './types.js';

const CALL_TIMEOUT_MS = 2000;

/** One row of `bd memories --json <term>`: memory key -> memory content. */
type BdMemories = Record<string, unknown>;

/**
 * Run `bd memories --json <term>` for a single term. Never throws: a missing
 * binary (ENOENT), non-zero exit, timeout, or unparseable JSON all collapse
 * to "no matches for this term" so one bad term can't sink the whole query.
 */
function queryTerm(term: string): BdMemories {
  // argv form, no shell: terms come from repository frontmatter and are
  // attacker-controlled when `lat` runs in a repo we don't own, so a term
  // must never be interpretable as shell syntax.
  const result = spawnSync('bd', ['memories', '--json', term], {
    // stdin: 'ignore' is load-bearing, not cosmetic. The shell version this
    // replaced ran its per-term loop inside a `while read` on stdin; an
    // external tool in that loop that itself read stdin would silently
    // consume the remaining terms, and the symptom was some documents just
    // never showing up — indistinguishable from "no match". Detaching stdin
    // here removes that whole class of bug.
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: CALL_TIMEOUT_MS,
    encoding: 'utf-8',
  });

  if (result.error || result.status !== 0 || !result.stdout) return {};

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as BdMemories;
    }
    return {};
  } catch {
    return {};
  }
}

async function query(q: StoreQuery): Promise<KnowledgeHit[]> {
  try {
    return rank(q);
  } catch {
    // The store contract is that a lookup never fails the caller's prompt.
    // queryTerm already absorbs a failing `bd`, but spawnSync itself can
    // throw on an argument it refuses rather than reporting it through
    // `error`, so the guarantee is made unconditional here.
    return [];
  }
}

function rank(q: StoreQuery): KnowledgeHit[] {
  // key -> { content, count }, built in first-seen order so a stable sort
  // below keeps ties in the author's original term order rather than an
  // alphabetical accident.
  const seen = new Map<string, { content: string; count: number }>();

  for (const term of q.terms) {
    const memories = queryTerm(term);
    for (const [key, content] of Object.entries(memories)) {
      if (!key || typeof content !== 'string' || content === '') continue;
      const existing = seen.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        seen.set(key, { content, count: 1 });
      }
    }
  }

  const hits: KnowledgeHit[] = [...seen.entries()].map(([key, v]) => ({
    store: 'bd' as const,
    key,
    title: key,
    detail: v.content.split('\n')[0] ?? '',
    score: v.count,
  }));

  // Array.prototype.sort is stable, so entries with equal score retain the
  // first-seen (author's term) order from the map iteration above.
  hits.sort((a, b) => b.score - a.score);

  return hits.slice(0, q.limit);
}

export const bdStore: Store = {
  name: 'bd',
  query,
};
