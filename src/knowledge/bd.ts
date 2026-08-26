import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import type { Store, StoreQuery, KnowledgeHit } from './types.js';

const CALL_TIMEOUT_MS = 2000;

/** One row of `bd memories --json <term>`: memory key -> memory content. */
type BdMemories = Record<string, unknown>;

/**
 * Run `bd memories --json <term>` for a single term. Never throws: a missing
 * binary (ENOENT), non-zero exit, timeout, or unparseable JSON all collapse
 * to "no matches for this term" so one bad term can't sink the whole query.
 *
 * Uses the async `execFile` (not `execFileSync`) so this call never blocks
 * the event loop: `federateTags` fans out to all three stores with
 * `Promise.allSettled`, and that fan-out only buys real concurrency if each
 * store's I/O actually yields control while its subprocess runs.
 */
function queryTerm(term: string): Promise<BdMemories> {
  return new Promise((resolvePromise) => {
    // argv form, no shell: terms come from repository frontmatter and are
    // attacker-controlled when `lat` runs in a repo we don't own, so a term
    // must never be interpretable as shell syntax.
    // stdin: 'ignore' is load-bearing, not cosmetic. The shell version this
    // replaced ran its per-term loop inside a `while read` on stdin; an
    // external tool in that loop that itself read stdin would silently
    // consume the remaining terms, and the symptom was some documents just
    // never showing up — indistinguishable from "no match". Detaching stdin
    // here removes that whole class of bug. `stdio` isn't in the string-
    // encoding overload's declared option type even though Node accepts it
    // at runtime, hence the explicit cast.
    const options = {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CALL_TIMEOUT_MS,
      encoding: 'utf-8',
    } as ExecFileOptionsWithStringEncoding;
    execFile(
      'bd',
      ['memories', '--json', term],
      options,
      (error: ExecFileException | null, stdout: string) => {
        // execFile's async form reports a non-zero exit and a timeout kill
        // both through `error`, and never rejects — so every failure mode
        // is handled right here rather than via a catch on the returned
        // promise. Match `queryTerm`'s old spawnSync contract of "empty
        // object" for anything that isn't a clean, parseable JSON object.
        if (error || !stdout) {
          resolvePromise({});
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            resolvePromise(parsed as BdMemories);
          } else {
            resolvePromise({});
          }
        } catch {
          resolvePromise({});
        }
      },
    );
  });
}

async function query(q: StoreQuery): Promise<KnowledgeHit[]> {
  try {
    return await rank(q);
  } catch {
    // The store contract is that a lookup never fails the caller's prompt.
    // queryTerm already absorbs a failing `bd`, but the surrounding logic
    // could still throw on an unexpected input, so the guarantee is made
    // unconditional here.
    return [];
  }
}

async function rank(q: StoreQuery): Promise<KnowledgeHit[]> {
  // key -> { content, count }, built in first-seen order so a stable sort
  // below keeps ties in the author's original term order rather than an
  // alphabetical accident.
  const seen = new Map<string, { content: string; count: number }>();

  // Terms belong to the same document, so their subprocess calls are
  // independent of each other — run them concurrently rather than one at a
  // time. Each individual call still enforces CALL_TIMEOUT_MS; running them
  // together bounds the whole document's bd lookup by that same timeout
  // instead of `terms.length * CALL_TIMEOUT_MS`.
  const perTerm = await Promise.all(q.terms.map((term) => queryTerm(term)));

  for (const memories of perTerm) {
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
