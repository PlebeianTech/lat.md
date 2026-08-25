import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../lattice.js';
import { UNTRUSTED_NOTICE, quoteUntrusted } from '../untrusted.js';
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

  const blocks: string[] = [];
  let emitted = 0;
  let attempts = 0;

  // Iterate in order; stop only on the two counters below, never mid-loop for
  // any other reason.
  for (const doc of docs) {
    if (emitted >= maxEmitted || attempts >= maxAttempts) break;

    // A skip does NOT spend an attempt: other documents later in this same
    // batch may be new, and letting them slide into the attempt window as
    // earlier ones are skipped is what keeps a repeated batch from starving
    // documents that have never been looked up.
    if (seen.has(doc.id)) continue;

    // Tags are only chosen; empty means nothing to search on. Also free —
    // don't spend an attempt on a document with nothing to query.
    const terms = tagsToTerms(doc.tags, maxTerms);
    if (terms.length === 0) continue;

    attempts++;

    // Never pool tags from two documents: each document is queried with only
    // its own terms, because two unrelated subjects intersect at nothing and
    // pooling would just produce noise attributed to the wrong document.
    const results = await Promise.allSettled(
      stores.map((store) =>
        queryStore(store, terms, opts.projectRoot, perStoreLimit),
      ),
    );

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
      continue;
    }

    emitted++;
    seen.add(doc.id);
    blocks.push(formatDocBlock(doc, hitsByStore, perStoreLimit));
  }

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
  // honest about what the document is tagged with.
  const lines: string[] = [`${doc.id} (${doc.tags.join(', ')}):`];

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
