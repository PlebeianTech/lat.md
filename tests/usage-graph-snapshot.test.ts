import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAggregator } from '../src/fork/usage/aggregate.js';
import {
  forgetSnapshots,
  graphSnapshotContribution,
  snapshotAt,
  snapshotGraphAtHead,
  type GraphSnapshot,
  type KnowledgeBreakdown,
} from '../src/fork/usage/graph-snapshot.js';
import {
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

let root: string;
let counter = 0;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf-8' },
  ).trim();
}

function write(relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-m', message);
  return git('rev-parse', 'HEAD');
}

const NOTES_V1 = `# Notes

Intro text.

## Alpha

Alpha text.

## Beta

Beta text.
`;

const NOTES_V2 = `# Notes

Intro text.

## Alpha

Alpha text, rewritten.
`;

const OTHER = `# Other

## Gamma

Gamma cites [[src/a.ts#alpha]] and links [[notes#Notes#Alpha]].
`;

// The marker is assembled so lat check does not scan this fixture as a ref.
const SOURCE = `// ${'@'}lat: [[notes#Notes#Alpha]]
export const alpha = 1;
`;

function usage(fields: Partial<UsageEvent>): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${counter}`,
    ts: '2026-11-08T10:00:00.000Z',
    duration_ms: 10,
    command: 'search',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: root,
    git_head: null,
    worktree: null,
    query: null,
    result_ids: [],
    result_count: null,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: 0,
    error_class: null,
    unknown_reasons: {},
    ...fields,
  };
}

async function knowledgeFor(
  events: UsageEvent[],
  filters?: Parameters<
    Awaited<ReturnType<typeof createAggregator>>['summary']
  >[0],
): Promise<KnowledgeBreakdown> {
  for (const event of events) writeUsageEvent(root, event);
  const aggregator = await createAggregator({
    root,
    sources: [],
    bd: { refresh: async () => null },
    contributions: [graphSnapshotContribution],
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await aggregator.refresh();
  const summary = await aggregator.summary(filters);
  return summary.extensions[
    graphSnapshotContribution.key
  ] as KnowledgeBreakdown;
}

const snapshotPath = (head: string) =>
  join(root, '.lat', 'usage', 'graph-snapshots', `${head}.json`);

let head1: string;
let head2: string;

beforeEach(() => {
  forgetSnapshots();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-graph-')));
  git('init', '-q');
  write('lat.md/notes.md', NOTES_V1);
  write('lat.md/other.md', OTHER);
  write('src/a.ts', SOURCE);
  head1 = commit('first');
  write('lat.md/notes.md', NOTES_V2);
  head2 = commit('second');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('usage graph snapshot', () => {
  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#The snapshot lists every section, document and code-ref edge]]
  it('lists every section, document and code-ref edge of a head', async () => {
    const snapshot = await snapshotGraphAtHead(root, head2, root);
    expect(snapshot.git_head).toBe(head2);
    const alpha = snapshot.sections.find(
      (s) => s.id === 'lat.md/notes#Notes#Alpha',
    );
    expect(alpha).toMatchObject({ document: 'lat.md/notes.md' });
    expect(alpha!.bytes).toBeGreaterThanOrEqual(
      Buffer.byteLength('Alpha text, rewritten.'),
    );
    expect(alpha!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.sections.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'lat.md/notes#Notes',
        'lat.md/notes#Notes#Alpha',
        'lat.md/other#Other#Gamma',
      ]),
    );
    const notes = snapshot.documents.find((d) => d.path === 'lat.md/notes.md');
    expect(notes!.bytes).toBe(Buffer.byteLength(NOTES_V2));
    expect(snapshot.code_ref_edges).toEqual([
      { file: 'src/a.ts', line: 1, section: 'lat.md/notes#Notes#Alpha' },
    ]);
    expect(snapshot.code_ref_edges_reason).toBeNull();
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A second call at the same head reuses the cache]]
  it('reuses the cached snapshot at the same head', async () => {
    const events = [
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes#Alpha',
      }),
    ];
    await knowledgeFor(events);
    const path = snapshotPath(head2);
    expect(existsSync(path)).toBe(true);
    const cached = JSON.parse(readFileSync(path, 'utf-8')) as GraphSnapshot;
    cached.sections.push({
      id: 'ghost#Ghost',
      document: 'lat.md/ghost.md',
      bytes: 1,
      hash: 'x',
    });
    writeFileSync(path, JSON.stringify(cached));

    forgetSnapshots();
    const second = await knowledgeFor([]);
    expect(second.never_read_sections.map((s) => s.id)).toContain(
      'ghost#Ghost',
    );
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A symlinked cache file is not read]]
  it('does not read a cache file that is a symlink', async () => {
    const events = [
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes#Alpha',
      }),
    ];
    await knowledgeFor(events);
    const path = snapshotPath(head2);
    const cached = JSON.parse(readFileSync(path, 'utf-8')) as GraphSnapshot;
    cached.sections.push({
      id: 'ghost#Ghost',
      document: 'lat.md/ghost.md',
      bytes: 1,
      hash: 'x',
    });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify(cached));
    rmSync(path);
    symlinkSync(outside, path);

    forgetSnapshots();
    const second = await knowledgeFor([]);
    expect(second.never_read_sections.map((s) => s.id)).not.toContain(
      'ghost#Ghost',
    );
    expect(readFileSync(outside, 'utf-8')).toBe(JSON.stringify(cached));
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#Never-read sections exclude sections read in range]]
  it('excludes sections read in range from the never-read list', async () => {
    const knowledge = await knowledgeFor([
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes#Alpha',
      }),
    ]);
    const ids = knowledge.never_read_sections.map((s) => s.id);
    expect(ids).not.toContain('lat.md/notes#Notes#Alpha');
    expect(ids).toContain('lat.md/other#Other#Gamma');
    expect(ids).toContain('lat.md/notes#Notes');
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A section deleted at a later head is not reported]]
  it('does not report a section deleted at the latest head', async () => {
    const knowledge = await knowledgeFor([
      usage({ git_head: head1, ts: '2026-11-08T09:00:00.000Z' }),
      usage({ git_head: head2, ts: '2026-11-08T10:00:00.000Z' }),
    ]);
    expect(knowledge.snapshot!.git_head).toBe(head2);
    const ids = knowledge.never_read_sections.map((s) => s.id);
    expect(ids).not.toContain('lat.md/notes#Notes#Beta');
    expect(ids).toContain('lat.md/notes#Notes#Alpha');
    expect(existsSync(snapshotPath(head1))).toBe(true);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A section hash is stable until its text changes]]
  it('keeps a section hash while its text is unchanged and changes it with the text', async () => {
    const before = await snapshotGraphAtHead(root, head1, null);
    const after = await snapshotGraphAtHead(root, head2, null);
    const hash = (snapshot: GraphSnapshot, id: string) =>
      snapshot.sections.find((s) => s.id === id)!.hash;
    expect(hash(after, 'lat.md/other#Other#Gamma')).toBe(
      hash(before, 'lat.md/other#Other#Gamma'),
    );
    expect(hash(after, 'lat.md/notes#Notes#Alpha')).not.toBe(
      hash(before, 'lat.md/notes#Notes#Alpha'),
    );
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A past head without a worktree stores no code-ref edges]]
  it('stores null code-ref edges with a reason when no worktree is at the head', async () => {
    const knowledge = await knowledgeFor([
      usage({
        git_head: head1,
        worktree: root,
        ts: '2026-11-08T09:00:00.000Z',
      }),
      usage({
        git_head: head2,
        worktree: root,
        ts: '2026-11-08T10:00:00.000Z',
      }),
    ]);
    expect(existsSync(snapshotPath(head1))).toBe(true);
    const past = JSON.parse(
      readFileSync(snapshotPath(head1), 'utf-8'),
    ) as GraphSnapshot;
    expect(past.code_ref_edges).toBeNull();
    expect(past.code_ref_edges_reason).toBe('not_captured');
    const current = JSON.parse(
      readFileSync(snapshotPath(head2), 'utf-8'),
    ) as GraphSnapshot;
    expect(current.code_ref_edges).toHaveLength(1);
    expect(knowledge.snapshot!.git_head).toBe(head2);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A stored past head is not built again]]
  it('reads a stored past head instead of building it again', async () => {
    await knowledgeFor([usage({ git_head: head1, worktree: root })]);
    expect(existsSync(snapshotPath(head1))).toBe(true);
    const stored = JSON.parse(
      readFileSync(snapshotPath(head1), 'utf-8'),
    ) as GraphSnapshot;
    stored.sections.push({
      id: 'ghost#Ghost',
      document: 'lat.md/ghost.md',
      bytes: 1,
      hash: 'x',
    });
    writeFileSync(snapshotPath(head1), JSON.stringify(stored));

    forgetSnapshots();
    const again = await snapshotAt(root, head1, [root]);
    expect(again.snapshot!.sections.map((s) => s.id)).toContain('ghost#Ghost');
    expect(again.snapshot!.code_ref_edges).toBeNull();
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A clean worktree gives a stored past head its code-ref edges]]
  it('builds a stored past head again only once a clean worktree is at it', async () => {
    await knowledgeFor([usage({ git_head: head1, worktree: root })]);
    expect(existsSync(snapshotPath(head1))).toBe(true);
    const stored = JSON.parse(
      readFileSync(snapshotPath(head1), 'utf-8'),
    ) as GraphSnapshot;
    stored.sections.push({
      id: 'ghost#Ghost',
      document: 'lat.md/ghost.md',
      bytes: 1,
      hash: 'x',
    });
    writeFileSync(snapshotPath(head1), JSON.stringify(stored));
    const holder = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-past-')));
    const checkout = join(holder, 'head1');
    try {
      git('worktree', 'add', '--detach', checkout, head1);
      writeFileSync(join(checkout, 'src/a.ts'), `${SOURCE}// uncommitted\n`);
      forgetSnapshots();
      const dirty = (await snapshotAt(root, head1, [checkout])).snapshot!;
      expect(dirty.code_ref_edges).toBeNull();
      expect(dirty.code_ref_edges_reason).toBe('not_captured');
      expect(dirty.sections.map((s) => s.id)).toContain('ghost#Ghost');
      expect(readFileSync(snapshotPath(head1), 'utf-8')).toBe(
        JSON.stringify(stored),
      );

      writeFileSync(join(checkout, 'src/a.ts'), SOURCE);
      forgetSnapshots();
      const clean = (await snapshotAt(root, head1, [checkout])).snapshot!;
      expect(clean.code_ref_edges).toEqual([
        { file: 'src/a.ts', line: 1, section: 'lat.md/notes#Notes#Alpha' },
      ]);
      expect(clean.sections.map((s) => s.id)).not.toContain('ghost#Ghost');
      const rewritten = JSON.parse(
        readFileSync(snapshotPath(head1), 'utf-8'),
      ) as GraphSnapshot;
      expect(rewritten.code_ref_edges).toHaveLength(1);
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#Symbol-ref edges are stored for past and current heads]]
  it('stores symbol-ref edges for a past head and the current head', async () => {
    const past = await snapshotGraphAtHead(root, head1, null);
    const current = await snapshotGraphAtHead(root, head2, root);
    const edge = { section: 'lat.md/other#Other#Gamma', file: 'src/a.ts' };
    expect(past.symbol_ref_edges).toEqual([edge]);
    expect(current.symbol_ref_edges).toEqual([edge]);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#Documents carry bytes and reads]]
  it('gives each document its bytes, reads and distinct sections read', async () => {
    const knowledge = await knowledgeFor([
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes#Alpha',
      }),
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes#Alpha',
      }),
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes',
      }),
    ]);
    const notes = knowledge.documents.find(
      (d) => d.path === 'lat.md/notes.md',
    )!;
    expect(notes).toEqual({
      path: 'lat.md/notes.md',
      bytes: Buffer.byteLength(NOTES_V2),
      reads: 3,
      sections_read: 2,
    });
    const other = knowledge.documents.find(
      (d) => d.path === 'lat.md/other.md',
    )!;
    expect(other.reads).toBe(0);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A loaded snapshot is not read again in the same process]]
  it('serves a repeated summary from memory without reading the cache file', async () => {
    const events = [
      usage({
        git_head: head2,
        worktree: root,
        command: 'section',
        section_id: 'lat.md/notes#Notes#Alpha',
      }),
    ];
    await knowledgeFor(events);
    rmSync(snapshotPath(head2));
    const second = await knowledgeFor([]);
    expect(second.snapshot!.git_head).toBe(head2);
    expect(existsSync(snapshotPath(head2))).toBe(false);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#Heads outside the range are not built]]
  it('builds snapshots only for heads in the range', async () => {
    await knowledgeFor(
      [
        usage({ git_head: head1, ts: '2026-11-01T10:00:00.000Z' }),
        usage({
          git_head: head2,
          worktree: root,
          ts: '2026-11-08T10:00:00.000Z',
        }),
      ],
      { from: '2026-11-05' },
    );
    expect(existsSync(snapshotPath(head2))).toBe(true);
    expect(existsSync(snapshotPath(head1))).toBe(false);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A corrupt cache file is rebuilt]]
  it('deletes a corrupt cache file and rebuilds the snapshot', async () => {
    mkdirSync(dirname(snapshotPath(head2)), { recursive: true });
    writeFileSync(snapshotPath(head2), '{not json');
    const result = await snapshotAt(root, head2, [root]);
    expect(result.snapshot!.git_head).toBe(head2);
    const rewritten = JSON.parse(readFileSync(snapshotPath(head2), 'utf-8'));
    expect(rewritten.git_head).toBe(head2);
  });

  const section = { id: 's', document: 'd.md', bytes: 1, hash: 'h' };
  const document = { path: 'd.md', bytes: 1 };
  const edge = { file: 'src/a.ts', section: 's' };
  const wellFormed = {
    git_head: 'x',
    sections: [section],
    documents: [document],
    code_ref_edges: [edge],
    code_ref_edges_reason: null,
    symbol_ref_edges: [edge],
  };

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A cache file of the wrong shape is rebuilt]]
  it.each<[string, unknown]>([
    ['only null code-ref edges', { code_ref_edges: null }],
    ['an array', []],
    ['a number', 5],
    ['no git head', { ...wellFormed, git_head: undefined }],
    ['no sections', { ...wellFormed, sections: undefined }],
    ['a section that is a number', { ...wellFormed, sections: [5] }],
    [
      'a section id that is a number',
      { ...wellFormed, sections: [{ ...section, id: 5 }] },
    ],
    [
      'a section with no document',
      { ...wellFormed, sections: [{ ...section, document: undefined }] },
    ],
    [
      'a section with no hash',
      { ...wellFormed, sections: [{ ...section, hash: undefined }] },
    ],
    [
      'section bytes that are text',
      { ...wellFormed, sections: [{ ...section, bytes: '1' }] },
    ],
    ['no documents', { ...wellFormed, documents: undefined }],
    [
      'a document path that is a number',
      { ...wellFormed, documents: [{ ...document, path: 5 }] },
    ],
    [
      'document bytes that are null',
      { ...wellFormed, documents: [{ ...document, bytes: null }] },
    ],
    ['code-ref edges that are text', { ...wellFormed, code_ref_edges: 'x' }],
    [
      'a code-ref edge with no file',
      { ...wellFormed, code_ref_edges: [{ section: 's' }] },
    ],
    ['no symbol-ref edges', { ...wellFormed, symbol_ref_edges: undefined }],
    [
      'a symbol-ref edge that is null',
      { ...wellFormed, symbol_ref_edges: [null] },
    ],
  ])('rebuilds a cache file holding %s', async (_, payload) => {
    mkdirSync(dirname(snapshotPath(head1)), { recursive: true });
    writeFileSync(snapshotPath(head1), JSON.stringify(payload));
    const knowledge = await knowledgeFor([
      usage({ git_head: head1, worktree: root }),
    ]);
    expect(knowledge.snapshot!.git_head).toBe(head1);
    expect(knowledge.never_read_sections.map((s) => s.id)).toContain(
      'lat.md/notes#Notes#Beta',
    );
    const rewritten = JSON.parse(readFileSync(snapshotPath(head1), 'utf-8'));
    expect(rewritten.git_head).toBe(head1);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A snapshot the code wrote is read back]]
  it('reads back a stored snapshot with null or listed code-ref edges', async () => {
    await knowledgeFor([
      usage({
        git_head: head1,
        worktree: root,
        ts: '2026-11-08T09:00:00.000Z',
      }),
      usage({
        git_head: head2,
        worktree: root,
        ts: '2026-11-08T10:00:00.000Z',
      }),
    ]);
    for (const head of [head1, head2]) {
      const stored = JSON.parse(
        readFileSync(snapshotPath(head), 'utf-8'),
      ) as GraphSnapshot;
      stored.sections.push({
        id: 'ghost#Ghost',
        document: 'lat.md/ghost.md',
        bytes: null,
        hash: 'x',
      });
      writeFileSync(snapshotPath(head), JSON.stringify(stored));
      forgetSnapshots();
      expect((await snapshotAt(root, head, [])).snapshot).toEqual(stored);
    }
    writeFileSync(snapshotPath(head2), JSON.stringify(wellFormed));
    forgetSnapshots();
    expect((await snapshotAt(root, head2, [])).snapshot).toEqual(wellFormed);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A symlinked cache directory is never used]]
  it('neither reads, writes nor deletes in a symlinked graph-snapshots directory', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, `${head2}.json`), '{not json');
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    symlinkSync(outside, join(root, '.lat', 'usage', 'graph-snapshots'));
    const result = await snapshotAt(root, head2, [root]);
    expect(result.snapshot!.git_head).toBe(head2);
    expect(readdirSync(outside)).toEqual([`${head2}.json`]);
    expect(readFileSync(join(outside, `${head2}.json`), 'utf-8')).toBe(
      '{not json',
    );
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A head git cannot show has no snapshot and a reason]]
  it('reports a null snapshot with a reason for an unshowable head', async () => {
    const missing = 'a'.repeat(40);
    const knowledge = await knowledgeFor([usage({ git_head: missing })]);
    expect(knowledge.snapshot).toBeNull();
    expect(knowledge.snapshot_reason).toEqual(expect.any(String));
    expect(knowledge.unavailable_heads).toEqual([
      { git_head: missing, reason: knowledge.snapshot_reason },
    ]);
    expect(existsSync(snapshotPath(missing))).toBe(false);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A head that is not a commit id touches no file]]
  it('refuses a head that is not a full commit id without touching a file', async () => {
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{not json');
    const escape = '../../../outside';
    expect(
      existsSync(
        `${join(root, '.lat', 'usage', 'graph-snapshots', escape)}.json`,
      ),
    ).toBe(true);
    for (const head of [escape, '--output=x', 'a'.repeat(39), 'A'.repeat(40)]) {
      const result = await snapshotAt(root, head, [root]);
      expect(result.snapshot).toBeNull();
      expect(result.reason).toBe('git head is not a full commit id');
    }
    expect(readFileSync(outside, 'utf-8')).toBe('{not json');
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A dirty worktree stores no code-ref edges]]
  it('stores null code-ref edges with a reason when the worktree is dirty', async () => {
    write('src/a.ts', `${SOURCE}// uncommitted edit\n`);
    const result = await snapshotAt(root, head2, [root]);
    expect(result.snapshot!.code_ref_edges).toBeNull();
    expect(result.snapshot!.code_ref_edges_reason).toBe('dirty_worktree');
    expect(existsSync(snapshotPath(head2))).toBe(false);
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A worktree outside the repository is never run]]
  it('runs no git in a candidate worktree that is not one of the repository', async () => {
    const hostile = realpathSync(
      mkdtempSync(join(tmpdir(), 'lat-usage-hostile-')),
    );
    try {
      execFileSync('git', ['clone', '-q', root, join(hostile, 'repo')]);
      const marker = join(hostile, 'ran');
      const hook = join(hostile, 'hook.sh');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      execFileSync('git', [
        '-C',
        join(hostile, 'repo'),
        'config',
        'core.fsmonitor',
        hook,
      ]);
      const result = await snapshotAt(root, head2, [join(hostile, 'repo')]);
      expect(result.snapshot!.code_ref_edges).toBeNull();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(hostile, { recursive: true, force: true });
    }
  });

  // @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A project below the repository root gets snapshots]]
  it('builds a snapshot for a project in a subdirectory of its repository', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-sub-')));
    try {
      const put = (relPath: string, content: string) => {
        mkdirSync(dirname(join(outer, relPath)), { recursive: true });
        writeFileSync(join(outer, relPath), content);
      };
      put('proj/lat.md/notes.md', NOTES_V1);
      put('proj/lat.md/other.md', OTHER);
      put('proj/src/a.ts', SOURCE);
      put('elsewhere/lat.md/stray.md', '# Stray\n');
      const run = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.name=test',
            '-c',
            'user.email=test@example.com',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd: outer, encoding: 'utf-8' },
        ).trim();
      run('init', '-q');
      run('add', '-A');
      run('commit', '-q', '-m', 'sub');
      const head = run('rev-parse', 'HEAD');
      const project = join(outer, 'proj');

      const result = await snapshotAt(project, head, [outer]);
      expect(result.reason).toBeNull();
      const snapshot = result.snapshot!;
      expect(snapshot.documents.map((d) => d.path).sort()).toEqual([
        'lat.md/notes.md',
        'lat.md/other.md',
      ]);
      expect(snapshot.sections.map((s) => s.id)).toEqual(
        expect.arrayContaining([
          'lat.md/notes#Notes#Alpha',
          'lat.md/other#Other#Gamma',
        ]),
      );
      expect(snapshot.code_ref_edges).toEqual([
        { file: 'src/a.ts', line: 1, section: 'lat.md/notes#Notes#Alpha' },
      ]);
      expect(snapshot.symbol_ref_edges).toEqual([
        { section: 'lat.md/other#Other#Gamma', file: 'src/a.ts' },
      ]);
      expect(existsSync(join(project, '.lat'))).toBe(false);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
