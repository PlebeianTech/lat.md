import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { rmDirBestEffort } from '../util.js';
import { join } from 'node:path';
import { federateTags } from '../../src/knowledge/index.js';
import { UNTRUSTED_NOTICE } from '../../src/untrusted.js';
import type {
  KnowledgeHit,
  Store,
  StoreQuery,
  TaggedDoc,
} from '../../src/knowledge/types.js';

function fakeStore(
  name: Store['name'],
  handler: (q: StoreQuery) => KnowledgeHit[],
): Store & { calls: StoreQuery[] } {
  const calls: StoreQuery[] = [];
  return {
    name,
    calls,
    async query(q: StoreQuery) {
      calls.push(q);
      return handler(q);
    },
  };
}

function doc(id: string, tags: string[]): TaggedDoc {
  return { id, tags };
}

const PROJECT_ROOT = '/tmp/project';

describe('federateTags', () => {
  it('iterates documents in order and emits blocks in that order', async () => {
    const cq = fakeStore('cq', (q) => [
      { store: 'cq', key: q.terms[0], title: q.terms[0], detail: '', score: 1 },
    ]);
    const docs = [doc('a', ['alpha-one']), doc('b', ['beta-two'])];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
    });
    expect(result).not.toBeNull();
    const posA = result!.indexOf('a (alpha-one):');
    const posB = result!.indexOf('b (beta-two):');
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(posA);
  });

  it('counts maxEmitted on documents that actually emit, not on candidates', async () => {
    // First doc has no hits, others do. maxEmitted=2 should let two
    // hit-producing docs through even though 3 docs were attempted.
    const cq = fakeStore('cq', (q) =>
      q.terms.includes('empty')
        ? []
        : [{ store: 'cq', key: 'k', title: 't', detail: '', score: 1 }],
    );
    const docs = [
      doc('empty', ['empty-tag']),
      doc('one', ['one-tag']),
      doc('two', ['two-tag']),
      doc('three', ['three-tag']),
    ];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
      maxEmitted: 2,
    });
    expect(result).toContain('one (one-tag):');
    expect(result).toContain('two (two-tag):');
    expect(result).not.toContain('three (three-tag):');
  });

  it('does not mark a zero-hit document seen, and does not count it as emitted', async () => {
    const cq = fakeStore('cq', () => []);
    const seen = new Set<string>();
    const docs = [doc('a', ['alpha-tag'])];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
      seen,
    });
    expect(result).toBeNull();
    expect(seen.has('a')).toBe(false);
  });

  it('skips a seen document without spending an attempt', async () => {
    const cq = fakeStore('cq', () => [
      { store: 'cq', key: 'k', title: 't', detail: '', score: 1 },
    ]);
    const seen = new Set<string>(['a']);
    const docs = [doc('a', ['alpha-tag']), doc('b', ['beta-tag'])];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
      seen,
      maxAttempts: 1,
    });
    // 'a' is skipped (no attempt spent), so 'b' still gets its one attempt.
    expect(cq.calls.length).toBe(1);
    expect(cq.calls[0].terms).toEqual(['beta', 'tag']);
    expect(result).toContain('b (beta-tag):');
  });

  it('stops once maxAttempts is spent', async () => {
    const cq = fakeStore('cq', () => []);
    const docs = [
      doc('a', ['alpha-tag']),
      doc('b', ['beta-tag']),
      doc('c', ['gamma-tag']),
    ];
    await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
      maxAttempts: 2,
    });
    expect(cq.calls.length).toBe(2);
  });

  it('never pools tags from two documents into one query', async () => {
    const cq = fakeStore('cq', () => [
      { store: 'cq', key: 'k', title: 't', detail: '', score: 1 },
    ]);
    const docs = [doc('a', ['alpha-tag']), doc('b', ['beta-tag'])];
    await federateTags(docs, { projectRoot: PROJECT_ROOT, stores: [cq] });
    expect(cq.calls).toHaveLength(2);
    expect(cq.calls[0].terms).toEqual(['alpha', 'tag']);
    expect(cq.calls[1].terms).toEqual(['beta', 'tag']);
  });

  it('emits the untrusted notice exactly once across a multi-document result', async () => {
    const cq = fakeStore('cq', () => [
      { store: 'cq', key: 'k', title: 't', detail: 'd', score: 1 },
    ]);
    const docs = [
      doc('a', ['alpha-tag']),
      doc('b', ['beta-tag']),
      doc('c', ['gamma-tag']),
    ];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
      maxEmitted: 3,
    });
    expect(result).not.toBeNull();
    const occurrences = result!.split(UNTRUSTED_NOTICE).length - 1;
    expect(occurrences).toBe(1);
  });

  it('omits store groups with no hits', async () => {
    const cq = fakeStore('cq', () => [
      { store: 'cq', key: 'k', title: 't', detail: '', score: 1 },
    ]);
    const bd = fakeStore('bd', () => []);
    const docs = [doc('a', ['alpha-tag'])];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq, bd],
    });
    expect(result).toContain('cq:');
    expect(result).not.toContain('bd memories:');
  });

  it('quotes hit text through quoteUntrusted, stripping control and bidi characters', async () => {
    const cq = fakeStore('cq', () => [
      {
        store: 'cq',
        key: 'k',
        title: 'evil\x1b[31mtitle‮reversed',
        detail: 'detail\x07text',
        score: 1,
      },
    ]);
    const docs = [doc('a', ['alpha-tag'])];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
    });
    expect(result).not.toBeNull();
    expect(result).not.toContain('\x1b');
    expect(result).not.toContain('‮');
    expect(result).not.toContain('\x07');
    expect(result).toContain('reversed');
    expect(result).toContain('detail text');
  });

  it('returns null when nothing is emitted', async () => {
    const cq = fakeStore('cq', () => []);
    const result = await federateTags([doc('a', ['alpha-tag'])], {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
    });
    expect(result).toBeNull();
  });

  it('the heading lists the whole authored tag list, not just the search terms', async () => {
    const cq = fakeStore('cq', () => [
      { store: 'cq', key: 'k', title: 't', detail: '', score: 1 },
    ]);
    const docs = [doc('a', ['run-pin', 'carry', 'query-param'])];
    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
    });
    expect(result).toContain('a (run-pin, carry, query-param):');
  });
});

const cliPath = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

describe('lat hook UserPromptSubmit federation (end to end)', () => {
  function runUserPromptSubmit(caseDir: string, prompt: string) {
    // Isolate every store from this machine's real state, per the spec's
    // acceptance criterion: no cq database (point CQ_LOCAL_DB_PATH at a path
    // that doesn't exist), no `bd` on PATH (a PATH with nothing on it), and
    // no reachable Claude Code memory directory (HOME pointed at an empty
    // dir this process doesn't otherwise use).
    const emptyHome = join(import.meta.dirname, '..', 'cases', 'tags-basic');
    // Use the absolute path to the running node binary (not the bare "node"
    // string) so clearing PATH below doesn't also break locating node itself.
    const result = spawnSync(
      process.execPath,
      [cliPath, 'hook', 'claude', 'UserPromptSubmit'],
      {
        cwd: caseDir,
        encoding: 'utf-8',
        input: JSON.stringify({ prompt }),
        env: {
          ...process.env,
          PATH: '',
          CQ_LOCAL_DB_PATH: join(caseDir, 'does-not-exist.db'),
          HOME: emptyHome,
          USERPROFILE: emptyHome,
        },
      },
    );
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('produces identical output to a document with no tags, on a machine with no stores configured', () => {
    const tagged = join(import.meta.dirname, '..', 'cases', 'tags-basic');
    const plain = join(import.meta.dirname, '..', 'cases', 'tags-basic-empty');

    // federateTags must find nothing and add nothing when every store is
    // unavailable, so a prompt referencing a *tagged* document produces
    // output byte-identical to the same prompt against a plain one.
    const withTags = runUserPromptSubmit(tagged, 'Update [[feature]]');
    const withoutTags = runUserPromptSubmit(plain, 'Update [[feature]]');

    expect(withTags.stdout).toBe(withoutTags.stdout);
    expect(withTags.stderr).toBe('');
  });
});

describe('federateTags: an unsearchable document is free', () => {
  // Rule 4 has the same shape as the `seen` skip and the same reason: a
  // document with no usable terms was never work, so charging it an attempt
  // would let a batch of untaggable documents starve the ones behind them.
  it('spends no attempt on a document whose tags yield no terms', async () => {
    const cq = fakeStore('cq', () => [
      { store: 'cq', key: 'k', title: 'hit', detail: '', score: 1 },
    ]);
    // 'ab' is below the 3-character floor, so it produces no terms at all.
    const docs = [doc('unsearchable', ['ab']), doc('real', ['alpha-one'])];

    const result = await federateTags(docs, {
      projectRoot: PROJECT_ROOT,
      stores: [cq],
      maxAttempts: 1,
    });

    // With only one attempt available, 'real' is reachable only if
    // 'unsearchable' cost nothing.
    expect(result).not.toBeNull();
    expect(result).toContain('real (alpha-one):');
    expect(cq.calls).toHaveLength(1);
    expect(cq.calls[0].terms).toEqual(['alpha', 'one']);
  });
});

describe('lat hook UserPromptSubmit federation with a live cq store', () => {
  // The regression this pins: federation used to make its own second,
  // unguarded runSearch() call inside the same try block that had just
  // collected the [[ref]] paths. An absent index makes runSearch return no
  // matches, but an UNUSABLE one — a truncated or half-written
  // lat.md/.cache/vectors.db — makes it throw, and the throw jumped past the
  // ref-derived documents so federation silently produced nothing. The
  // [[ref]] path resolves without touching the index and must survive that.
  let tmp: string;
  let dbPath: string;
  let caseDir: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lat-fed-cq-'));

    // A copy of tags-basic carrying a corrupt vector index.
    caseDir = join(tmp, 'project');
    cpSync(join(import.meta.dirname, '..', 'cases', 'tags-basic'), caseDir, {
      recursive: true,
    });
    mkdirSync(join(caseDir, 'lat.md', '.cache'), { recursive: true });
    writeFileSync(
      join(caseDir, 'lat.md', '.cache', 'vectors.db'),
      'not a database',
    );

    dbPath = join(tmp, 'cq.db');
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute(
      'CREATE VIRTUAL TABLE knowledge_units_fts USING fts5(summary, action)',
    );
    await client.execute({
      sql: 'INSERT INTO knowledge_units_fts (summary, action) VALUES (?, ?)',
      args: ['A run-pin lesson', 'Pin the run before carrying it'],
    });
    client.close();
  });

  afterAll(() => {
    rmDirBestEffort(tmp);
  });

  it('federates a [[ref]] document when the vector index is unusable', () => {
    const emptyHome = join(tmp, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [cliPath, 'hook', 'claude', 'UserPromptSubmit'],
      {
        cwd: caseDir,
        encoding: 'utf-8',
        input: JSON.stringify({ prompt: 'Update [[feature]]' }),
        env: {
          ...process.env,
          PATH: '',
          CQ_LOCAL_DB_PATH: dbPath,
          HOME: emptyHome,
          USERPROFILE: emptyHome,
        },
      },
    );
    const stdout = result.stdout ?? '';
    expect(result.stderr ?? '').toBe('');
    expect(stdout).toContain('Section tags matched stored knowledge');
    expect(stdout).toContain('lat.md/feature.md (run-pin, carry):');
    expect(stdout).toContain('A run-pin lesson');
  });
});
