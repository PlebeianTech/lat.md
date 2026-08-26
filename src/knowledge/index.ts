import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../lattice.js';
import {
  UNTRUSTED_NOTICE,
  quoteUntrusted,
  cleanUntrustedId,
} from '../untrusted.js';
import { tagsToTerms, capHits } from './ranking.js';
import type { Store, StoreName, KnowledgeHit, TaggedDoc } from './types.js';

const STORE_GROUP_LABELS: Record<StoreName, string> = {
  cq: 'cq:',
  bd: 'bd memories:',
  'claude-memory': 'Claude Code memory:',
};

function storeExportName(name: StoreName): string {
  switch (name) {
    case 'cq':
      return 'cqStore';
    case 'bd':
      return 'bdStore';
    case 'claude-memory':
      return 'claudeMemoryStore';
  }
}

/**
 * Loads and returns the three built-in stores. A function, not a static
 * array: cq.ts, bd.ts, and claude-memory.ts are owned by other agents and may
 * not exist yet, so the import must happen dynamically at call time (inside
 * federateTags, via this function) rather than at module load — a top-level
 * static import would fail this module's typecheck while they're mid-write.
 * Each import is wrapped individually so one missing/broken store module
 * leaves the other two available, per the "every store is optional" contract
 * in types.ts.
 */
export async function DEFAULT_STORES(): Promise<Store[]> {
  const stores: Store[] = [];
  const specs: Array<{ path: string; name: StoreName }> = [
    { path: './cq.js', name: 'cq' },
    { path: './bd.js', name: 'bd' },
    { path: './claude-memory.js', name: 'claude-memory' },
  ];
  for (const spec of specs) {
    try {
      const mod: unknown = await import(spec.path);
      const store = (mod as Record<string, unknown>)[
        storeExportName(spec.name)
      ];
      if (store && typeof (store as Store).query === 'function') {
        stores.push(store as Store);
      }
    } catch {
      // Absent module, missing binary, etc. — treated as "store not present".
    }
  }
  return stores;
}

export type FederateOptions = {
  projectRoot: string;
  /** Stores to query. Defaults to all three (loaded dynamically). */
  stores?: Store[];
  /** Max hits one store may return for one document. Default 3. */
  perStoreLimit?: number;
  /** Max terms taken from one tag list. Default 2. */
  maxTerms?: number;
  /** Max documents that actually EMIT a block. Default 3. */
  maxEmitted?: number;
  /** Max documents a lookup is attempted for. Default 20. */
  maxAttempts?: number;
  /** Document ids already surfaced. Mutated as documents are emitted. */
  seen?: Set<string>;
  /**
   * Document ids that were looked up on a previous call and came back
   * empty. Distinct from `seen`: an entry here is never emitted, so it must
   * stay retryable (a store may later have something to say), but it should
   * not re-spend an attempt on every call — otherwise a batch of zero-yield
   * documents ahead of an answerable one starves that document forever,
   * since nothing about the situation changes between calls. Skipping an
   * already-attempted-empty document for free lets the attempt budget
   * advance past it on the next call, rotating the scan window forward.
   * Mutated as documents come back empty; not persisted by this function.
   */
  attemptedEmpty?: Set<string>;
  /** Max documents queried concurrently. Default 4. */
  concurrency?: number;
  /** Overall wall-clock budget for the whole call, in ms. Default 5000. */
  deadlineMs?: number;
};

async function queryStore(
  store: Store,
  terms: string[],
  projectRoot: string,
  limit: number,
): Promise<KnowledgeHit[]> {
  try {
    return await store.query({ terms, projectRoot, limit });
  } catch {
    // A store must never throw per its contract, but a caller-injected fake
    // in tests might — treat a rejection the same as an empty result so one
    // misbehaving store can't take down federation for every document.
    return [];
  }
}

/**
 * Resolve `promise`, or `null` if `ms` elapses first.
 *
 * The abandoned promise keeps running — an in-flight store query cannot be
 * cancelled — but nothing awaits it, so it cannot hold the prompt open. The
 * timer is unref'd so a pending race never keeps the process alive.
 */
function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(null));
  });
}

export async function federateTags(
  docs: TaggedDoc[],
  opts: FederateOptions,
): Promise<string | null> {
  const stores = opts.stores ?? (await DEFAULT_STORES());
  const perStoreLimit = opts.perStoreLimit ?? 3;
  const maxTerms = opts.maxTerms ?? 2;
  const maxEmitted = opts.maxEmitted ?? 3;
  const maxAttempts = opts.maxAttempts ?? 20;
  const seen = opts.seen ?? new Set<string>();
  const attemptedEmpty = opts.attemptedEmpty ?? new Set<string>();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const deadlineAt = Date.now() + (opts.deadlineMs ?? 5000);

  // A document with a hit is buffered here by its original index rather
  // than accepted immediately: under concurrency, several documents can
  // resolve with hits before any of them has been checked against
  // maxEmitted, so acceptance is decided once, in document order, after all
  // workers finish. That is what keeps the final `seen`/emitted count
  // identical to the fully-sequential version — see the acceptance step
  // below — even though the queries themselves now overlap.
  const candidates = new Map<
    number,
    { doc: TaggedDoc; hitsByStore: Map<StoreName, KnowledgeHit[]> }
  >();
  let attempts = 0;
  let cursor = 0;

  // Each worker pulls the next document off a shared cursor and races the
  // others via Promise.all below. Everything up to and including the
  // `attempts++` happens synchronously (no `await` in between), so — since
  // JS runs one microtask at a time — the cursor, the skip checks, and the
  // attempt count advance in exactly the same document order and with
  // exactly the same skip/spend decisions as the single-worker (fully
  // sequential) version. Only the store queries themselves overlap.
  //
  // One divergence, deliberate and bounded: `candidates.size` is a soft
  // stopping signal standing in for the true accepted count, which isn't
  // known until the acceptance step below runs. Workers claim their next
  // document before any in-flight query has resolved, so up to
  // `concurrency - 1` documents beyond the maxEmitted cutoff can still be
  // attempted. That never yields FEWER accepted blocks (accepted is always
  // <= candidates.size), and anything it records is true — a document marked
  // attemptedEmpty really was queried and really came back empty. It costs
  // at most a few extra queries per call and rotates through the list
  // slightly faster than the sequential version would.
  async function worker(): Promise<void> {
    for (;;) {
      if (candidates.size >= maxEmitted || attempts >= maxAttempts) return;
      if (Date.now() >= deadlineAt) return;
      const index = cursor;
      if (index >= docs.length) return;
      cursor++;
      const doc = docs[index];

      // A skip does NOT spend an attempt: other documents later in this same
      // batch may be new, and letting them slide into the attempt window as
      // earlier ones are skipped is what keeps a repeated batch from
      // starving documents that have never been looked up.
      if (seen.has(doc.id)) continue;

      // A previous call already spent an attempt on this document and found
      // nothing. Skipping it for free (no attempt spent) lets the attempt
      // budget reach further into the list on this call than it did last
      // time, instead of re-spending the same budget on the same dead end.
      if (attemptedEmpty.has(doc.id)) continue;

      // Tags are only chosen; empty means nothing to search on. Also free —
      // don't spend an attempt on a document with nothing to query.
      const terms = tagsToTerms(doc.tags, maxTerms);
      if (terms.length === 0) continue;

      attempts++;

      // Never pool tags from two documents: each document is queried with
      // only its own terms, because two unrelated subjects intersect at
      // nothing and pooling would just produce noise attributed to the
      // wrong document.
      // The deadline has to bound total wall clock, not just dispatch. bd and
      // claude-memory cap their own subprocess calls at CALL_TIMEOUT_MS, but
      // cq's libsql `execute` carries no timeout of its own, so a locked
      // database file would otherwise hold this worker — and the prompt —
      // open with no bound at all. Racing the queries against the remaining
      // budget is what makes the deadline hard rather than advisory: an
      // overrunning store is abandoned, never awaited.
      const results = await raceDeadline(
        Promise.allSettled(
          stores.map((store) =>
            queryStore(store, terms, opts.projectRoot, perStoreLimit),
          ),
        ),
        deadlineAt - Date.now(),
      );

      // Deadline expired mid-query. Return what has been gathered. The
      // document is deliberately NOT marked attemptedEmpty: it was never
      // answered, so a later call must be free to try it again.
      if (results === null) return;

      const hitsByStore = new Map<StoreName, KnowledgeHit[]>();
      for (let i = 0; i < stores.length; i++) {
        const result = results[i];
        const hits = result.status === 'fulfilled' ? result.value : [];
        if (hits.length > 0) {
          hitsByStore.set(stores[i].name, hits);
        }
      }

      if (hitsByStore.size === 0) {
        // Nothing found: don't mark seen, don't count as emitted. A document
        // that produced nothing stays unmarked so a later run — once the
        // stores have something to say — can still surface it.
        attemptedEmpty.add(doc.id);
        continue;
      }

      candidates.set(index, { doc, hitsByStore });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, docs.length) }, () => worker()),
  );

  // Accept candidates in document order, exactly as the sequential version
  // would have, and only up to maxEmitted — this is what turns the soft,
  // racy `candidates.size` stop above into an exact budget. A candidate
  // beyond the cutoff is dropped: not marked seen, not counted, left
  // exactly as untouched as a document the sequential version never reached.
  const acceptedIndices = [...candidates.keys()]
    .sort((a, b) => a - b)
    .slice(0, maxEmitted);
  const blocks = acceptedIndices.map((index) => {
    const { doc, hitsByStore } = candidates.get(index)!;
    seen.add(doc.id);
    return formatDocBlock(doc, hitsByStore, perStoreLimit);
  });

  if (blocks.length === 0) return null;

  // UNTRUSTED_NOTICE appears exactly once, at the top of the whole result —
  // never once per document.
  return [
    UNTRUSTED_NOTICE,
    'Section tags matched stored knowledge (auto-searched, verify before trusting):',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function formatDocBlock(
  doc: TaggedDoc,
  hitsByStore: Map<StoreName, KnowledgeHit[]>,
  perStoreLimit: number,
): string {
  // The heading lists the document's WHOLE authored tag list, even though
  // only the first two (maxTerms) drove the search — that keeps the heading
  // honest about what the document is tagged with. doc.id and doc.tags come
  // from repository frontmatter and are as untrusted as any hit text, so
  // both go through cleanUntrustedId before joining.
  const cleanId = cleanUntrustedId(doc.id);
  const cleanTags = doc.tags.map((tag) => cleanUntrustedId(tag));
  const lines: string[] = [`${cleanId} (${cleanTags.join(', ')}):`];

  for (const [storeName, hits] of hitsByStore) {
    const capped = capHits(hits, perStoreLimit);
    const hitLines: string[] = [];
    for (const hit of capped) {
      const title = quoteUntrusted(hit.title, 200);
      if (!hit.detail) {
        // Omit a hit whose detail is empty rather than printing empty
        // quotes; keep just the title.
        hitLines.push(`- ${title}`);
        continue;
      }
      const detail = quoteUntrusted(hit.detail, 220);
      hitLines.push(`- ${title} -> ${detail}`);
    }
    if (hitLines.length === 0) continue;
    lines.push(STORE_GROUP_LABELS[storeName]);
    lines.push(...hitLines);
  }

  return lines.join('\n');
}

/**
 * Tagged documents for the given project-relative markdown paths, in order,
 * deduped by path.
 */
export async function taggedDocsForFiles(
  projectRoot: string,
  filePaths: string[],
): Promise<TaggedDoc[]> {
  const docs: TaggedDoc[] = [];
  const seenPaths = new Set<string>();

  for (const filePath of filePaths) {
    const id = filePath.split('\\').join('/');
    if (seenPaths.has(id)) continue;
    seenPaths.add(id);

    let content: string;
    try {
      content = await readFile(join(projectRoot, filePath), 'utf-8');
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    const rawTags = fm.raw['tags'];
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((t): t is string => typeof t === 'string')
      : typeof rawTags === 'string'
        ? [rawTags]
        : [];

    if (tags.length === 0) continue;

    docs.push({ id, tags });
  }

  return docs;
}
