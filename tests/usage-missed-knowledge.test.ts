import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAggregator } from '../src/fork/usage/aggregate.js';
import type {
  AggregateContext,
  Contribution,
} from '../src/fork/usage/aggregate-types.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import type { BdIssue } from '../src/fork/usage/bd-client.js';
import type { UsageFilters } from '../src/fork/usage/filters.js';
import {
  forgetSnapshots,
  snapshotAt,
  type GraphSnapshot,
} from '../src/fork/usage/graph-snapshot.js';
import {
  MISSED_KNOWLEDGE_METHOD_VERSION,
  forgetMissedKnowledge,
  missedKnowledgeContribution,
  readLineAt,
  type MissedKnowledge,
} from '../src/fork/usage/missed-knowledge.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type {
  SessionAgent,
  SessionSource,
} from '../src/fork/usage/sources/types.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

// Keeps the real snapshot behaviour and cache; only counts the calls.
vi.mock('../src/fork/usage/graph-snapshot.js', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../src/fork/usage/graph-snapshot.js')
    >();
  return { ...real, snapshotAt: vi.fn(real.snapshotAt) };
});

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const ALPHA = 'lat.md/notes#Notes#Alpha';
const BETA = 'lat.md/notes#Notes#Beta';
const GAMMA = 'lat.md/other#Other#Gamma';

let root: string;
let head: string;
let counter = 0;

function git(cwd: string, ...args: string[]): string {
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
    { cwd, encoding: 'utf-8' },
  ).trim();
}

function write(base: string, relPath: string, content: string): void {
  const path = join(base, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function snapshotOf(
  gitHead: string,
  fields: Partial<GraphSnapshot> = {},
): GraphSnapshot {
  return {
    git_head: gitHead,
    sections: [ALPHA, BETA, GAMMA].map((id) => ({
      id,
      document: `${id.split('#')[0]}.md`,
      bytes: 10,
      hash: 'h',
    })),
    documents: [
      { path: 'lat.md/notes.md', bytes: 100 },
      { path: 'lat.md/other.md', bytes: 100 },
    ],
    code_ref_edges: [
      { file: 'src/a.ts', line: 1, section: ALPHA },
      { file: 'src/b.ts', line: 1, section: ALPHA },
      { file: 'src/c.ts', line: 1, section: BETA },
      { file: 'src/d.ts', line: 1, section: GAMMA },
    ],
    code_ref_edges_reason: null,
    symbol_ref_edges: [],
    ...fields,
  };
}

function cacheSnapshot(base: string, snapshot: GraphSnapshot): void {
  write(
    base,
    `.lat/usage/graph-snapshots/${snapshot.git_head}.json`,
    JSON.stringify(snapshot),
  );
}

function usage(fields: Partial<UsageEvent>): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${counter}`,
    ts: at(0),
    duration_ms: 10,
    command: 'section',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: root,
    git_head: head,
    worktree: root,
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

const read = (minutes: number, id: string, fields: Partial<UsageEvent> = {}) =>
  usage({ ts: at(minutes), section_id: id, ...fields });

const search = (
  minutes: number,
  query: string,
  ids: string[],
  fields: Partial<UsageEvent> = {},
) =>
  usage({
    ts: at(minutes),
    command: 'search',
    query,
    result_ids: ids,
    result_count: ids.length,
    ...fields,
  });

function sessionEvent(
  kind: SessionEvent['kind'],
  sessionId: string,
  minutes: number,
  extra: Record<string, unknown> = {},
): SessionEvent {
  counter++;
  return {
    kind,
    event_id: `s${counter}`,
    session_id: sessionId,
    ts: at(minutes),
    source: { path: `/fake/${sessionId}.jsonl`, offset: counter },
    ...extra,
  } as SessionEvent;
}

const toolCall = (
  sessionId: string,
  minutes: number,
  action: 'read' | 'edit' | 'search' | 'shell',
  path: string | null,
  extra: Record<string, unknown> = {},
) =>
  sessionEvent('tool_call', sessionId, minutes, {
    tool: { name: 'tool', action, path, bytes: null, ...extra },
  });

/** A session from `start` to `end` minutes, with one token message so it has an item. */
function sessionOf(
  sessionId: string,
  edits: [number, string][],
  start = 0,
  end = 60,
): SessionEvent[] {
  return [
    sessionEvent('session_start', sessionId, start),
    sessionEvent('token_usage', sessionId, start + 0.1, {
      usage: {
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        reasoning: null,
      },
    }),
    ...edits.map(([minutes, path]) =>
      toolCall(sessionId, minutes, 'edit', path),
    ),
    sessionEvent('session_end', sessionId, end),
  ];
}

const claim = (sessionId: string, issueId: string) =>
  sessionEvent('bd_command', sessionId, -1, {
    verb: 'claim',
    issue_id: issueId,
  });

function issue(id: string, type: string, parent?: string): BdIssue {
  return {
    id,
    title: id,
    status: 'open',
    issue_type: type,
    created_at: at(-10_000),
    ...(parent ? { parent } : {}),
  };
}

function fakeSource(
  agent: SessionAgent,
  events: SessionEvent[],
): SessionSource {
  return {
    agent,
    discover: async () => (events.length ? [`/fake/${agent}.jsonl`] : []),
    read: async () => ({
      events,
      checkpoint: { offset: events.length },
      reason: null,
    }),
  };
}

interface Run {
  usage?: UsageEvent[];
  events?: SessionEvent[];
  codexEvents?: SessionEvent[];
  issues?: BdIssue[];
  snapshots?: GraphSnapshot[];
  filters?: UsageFilters;
  dir?: string;
  baseline?: boolean;
  baselineWorktree?: string | null;
  contributions?: Contribution[];
}

async function run(options: Run = {}): Promise<MissedKnowledge> {
  const dir = options.dir ?? root;
  for (const snapshot of options.snapshots ?? [snapshotOf(head)]) {
    cacheSnapshot(dir, snapshot);
  }
  const baseline =
    options.baseline === false
      ? []
      : [
          usage({
            ts: at(-1),
            command: 'check',
            caller: 'human',
            agent: null,
            session_id: null,
            repo_root: dir,
            git_head: options.snapshots?.[0]?.git_head ?? head,
            ...(options.baselineWorktree !== undefined && {
              worktree: options.baselineWorktree,
            }),
          }),
        ];
  for (const event of [...baseline, ...(options.usage ?? [])])
    writeUsageEvent(dir, event);
  const bd: BdSnapshot = {
    issues: options.issues ?? [],
    discoveredFrom: [],
    reopens: [],
  };
  const aggregator = await createAggregator({
    root: dir,
    sources: [
      fakeSource('claude', options.events ?? []),
      fakeSource('codex', options.codexEvents ?? []),
    ],
    bd: { refresh: async () => bd },
    contributions: [
      missedKnowledgeContribution,
      ...(options.contributions ?? []),
    ],
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await aggregator.refresh();
  const summary = await aggregator.summary(options.filters);
  return summary.extensions[missedKnowledgeContribution.key] as MissedKnowledge;
}

/** The outcome of one section in one session. */
const outcomeOf = (result: MissedKnowledge, sessionId: string, id: string) =>
  result.records.find((r) => r.session_id === sessionId && r.section_id === id)
    ?.outcome;

const EDIT_A: [number, string][] = [[10, 'src/a.ts']];

beforeEach(() => {
  forgetSnapshots();
  forgetMissedKnowledge();
  counter = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-missed-')));
  git(root, 'init', '-q');
  for (const file of ['a', 'b', 'c', 'd', 'old']) {
    write(root, `src/${file}.ts`, `export const ${file} = 1;\n`);
  }
  write(root, 'lat.md/notes.md', '# Notes\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'first');
  head = git(root, 'rev-parse', 'HEAD');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('usage missed knowledge', () => {
  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Prepare and compute run once per context]]
  it('prepares and computes once per context', async () => {
    let context: AggregateContext | undefined;
    await run({
      events: sessionOf('A', EDIT_A),
      contributions: [
        {
          key: 'probe',
          compute: (seen) => {
            context = seen;
            return null;
          },
        },
      ],
    });
    const seen = context!;
    const first = missedKnowledgeContribution.compute(seen);
    vi.mocked(snapshotAt).mockClear();
    await missedKnowledgeContribution.prepare!(seen);
    await missedKnowledgeContribution.prepare!(seen);
    expect(snapshotAt).not.toHaveBeenCalled();
    expect(missedKnowledgeContribution.compute(seen)).toBe(first);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section read before the first edit is reached]]
  it('marks a section read before the first edit as reached', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [read(5, ALPHA)],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('reached');
    expect(result.totals.reach).toBe(1);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section read before the first edit is reached]]
  it('counts a lat expand result as a read', async () => {
    const expand = await run({
      events: sessionOf('A', EDIT_A),
      usage: [
        usage({
          ts: at(5),
          command: 'expand',
          result_ids: [ALPHA],
          result_count: 1,
        }),
      ],
    });
    expect(outcomeOf(expand, 'A', ALPHA)).toBe('reached');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section read before the first edit is reached]]
  it('counts an MCP section call as a read', async () => {
    const mcp = await run({
      events: sessionOf('A', EDIT_A),
      usage: [read(5, ALPHA, { surface: 'mcp' })],
    });
    expect(outcomeOf(mcp, 'A', ALPHA)).toBe('reached');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section read after the first edit is read-late]]
  it('marks a section read only after the first edit as read-late', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [read(15, ALPHA)],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('read-late');
    expect(result.totals.reach).toBe(0);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Read-late uses the earliest edit of any covered file]]
  it('judges a read against the earliest edit of any covered file', async () => {
    const result = await run({
      events: sessionOf('A', [
        [10, 'src/a.ts'],
        [20, 'src/b.ts'],
      ]),
      usage: [read(15, ALPHA)],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('read-late');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A raw read of the lat.md file is bypassed]]
  it('marks a section whose document was read raw as bypassed', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', [
          [10, 'src/a.ts'],
          [11, 'src/d.ts'],
        ]),
        sessionEvent('bypass_read', 'A', 3, {
          path: 'lat.md/notes.md',
          bytes: 10,
        }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('bypassed');
    expect(outcomeOf(result, 'A', GAMMA)).toBe('never-consulted');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A raw read of the lat.md file is bypassed]]
  it('treats a native Grep under lat.md as bypassed, not as a search', async () => {
    const result = await run({
      events: [...sessionOf('A', EDIT_A), toolCall('A', 3, 'search', 'lat.md')],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('bypassed');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A raw read of the lat.md file is bypassed]]
  it('does not treat a native search outside lat.md as bypass', async () => {
    const elsewhere = await run({
      events: [...sessionOf('A', EDIT_A), toolCall('A', 3, 'search', 'src')],
    });
    expect(outcomeOf(elsewhere, 'A', ALPHA)).toBe('never-consulted');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A raw read of the lat.md file is bypassed]]
  it('does not count a native Grep as a search for another document', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', [[10, 'src/d.ts']]),
        toolCall('A', 3, 'search', 'lat.md/notes.md'),
      ],
    });
    expect(outcomeOf(result, 'A', GAMMA)).toBe('never-consulted');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The outcomes are checked in order]]
  it('prefers reached when a section is read before and after the edit', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [read(5, ALPHA), read(15, ALPHA)],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('reached');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section found but not opened is found-not-opened]]
  it('marks a section in a search result that was never read', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [search(5, 'alpha', [ALPHA])],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('found-not-opened');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section found but not opened is found-not-opened]]
  it('counts a hook injected result list as found', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [
        usage({
          ts: at(5),
          command: 'hook claude UserPromptSubmit',
          surface: 'hook',
          caller: 'hook-injected',
          result_ids: [ALPHA, BETA],
          result_count: 2,
        }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('found-not-opened');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A search that never returned the section is searched-not-found]]
  it('marks searched-not-found and lists the queries before the first edit', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [
        search(5, 'Foo   Bar', [BETA]),
        search(6, 'foo bar', [BETA]),
        search(20, 'Late Query', [BETA]),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('searched-not-found');
    const record = result.records.find((r) => r.section_id === ALPHA)!;
    expect(record.queries_before_first_edit).toEqual(['foo bar']);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A search that never returned the section is searched-not-found]]
  it('does not count a human search as a search', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [search(5, 'alpha', [BETA], { caller: 'human' })],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('never-consulted');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A section nothing touched is never-consulted]]
  it('gives a session that only ran lat check never-consulted', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [usage({ ts: at(5), command: 'check' })],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('never-consulted');
    expect(result.records).toHaveLength(1);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The outcomes are checked in order]]
  it('lets the earlier outcome in the order win', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', EDIT_A),
        ...sessionOf('B', EDIT_A),
        ...sessionOf('C', EDIT_A),
        sessionEvent('bypass_read', 'A', 3, {
          path: 'lat.md/notes.md',
          bytes: 1,
        }),
        sessionEvent('bypass_read', 'B', 3, {
          path: 'lat.md/notes.md',
          bytes: 1,
        }),
      ],
      usage: [
        read(15, ALPHA, { session_id: 'A' }),
        search(5, 'a', [ALPHA], { session_id: 'A' }),
        search(5, 'b', [ALPHA], { session_id: 'B' }),
        search(5, 'c', [ALPHA], { session_id: 'C' }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('read-late');
    expect(outcomeOf(result, 'B', ALPHA)).toBe('bypassed');
    expect(outcomeOf(result, 'C', ALPHA)).toBe('found-not-opened');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A hook injected body counts as a read]]
  it('counts a hook injected full body before the first edit as reached', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      usage: [
        usage({
          ts: at(5),
          command: 'hook claude UserPromptSubmit',
          surface: 'hook',
          caller: 'hook-injected',
          result_ids: [ALPHA],
          result_count: 1,
          section_id: ALPHA,
        }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('reached');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A lat section in a shell call is a fallback read]]
  it('reads an exact section id from a shell call through its source pointer', async () => {
    const transcript = join(root, 'transcript.jsonl');
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: `lat section "${ALPHA}" | head`, secret: 'x' },
          },
        ],
      },
    });
    const filler = '{"type":"user"}\n';
    writeFileSync(transcript, `${filler}${line}\n`);
    const shell = sessionEvent('tool_call', 'A', 5, {
      tool: {
        name: 'Bash',
        action: 'shell',
        path: null,
        bytes: null,
        shell: { exit_code: { value: 0 } },
      },
      source: { path: transcript, offset: Buffer.byteLength(filler) },
    });
    const result = await run({
      events: [...sessionOf('A', EDIT_A), shell],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('reached');
    expect(JSON.stringify(result)).not.toContain('lat section');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A lat section in a shell call is a fallback read]]
  it('ignores a shell call whose query is not an exact section id', async () => {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      `${JSON.stringify({ input: { command: 'lat section "alpha"' } })}\n`,
    );
    const shell = sessionEvent('tool_call', 'A', 5, {
      tool: {
        name: 'Bash',
        action: 'shell',
        path: null,
        bytes: null,
        shell: { exit_code: { value: 0 } },
      },
      source: { path: transcript, offset: 0 },
    });
    const result = await run({ events: [...sessionOf('A', EDIT_A), shell] });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('never-consulted');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Files without a section are no-coverage]]
  it('splits uncovered files into new-file and undocumented', async () => {
    const result = await run({
      events: sessionOf('A', [
        [10, 'src/a.ts'],
        [11, 'src/new.ts'],
        [12, 'src/old.ts'],
        [13, 'src/old.ts'],
      ]),
    });
    expect(result.totals.no_coverage).toEqual({
      new_file: 1,
      undocumented: 1,
      unclassified: 0,
    });
    expect(result.undocumented_files).toEqual([
      { path: 'src/old.ts', sessions: 1, edits: 2 },
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.sessions[0].had_a_miss).toBe(true);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Files without a section are no-coverage]]
  it('does not count an edit under lat.md/ as a source file', async () => {
    const result = await run({
      events: sessionOf('A', [
        [10, 'lat.md/notes.md'],
        [11, 'lat.md/notes.md'],
      ]),
    });
    expect(result.undocumented_files).toEqual([]);
    expect(result.sessions[0].status).toBe('no_edits');
    expect(result.sessions[0].no_coverage).toEqual({
      new_file: 0,
      undocumented: 0,
      unclassified: 0,
    });
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Files without a section are no-coverage]]
  it('reports unclassified files when the tree cannot be listed', async () => {
    const fake = 'e'.repeat(40);
    const result = await run({
      snapshots: [snapshotOf(fake)],
      events: sessionOf('A', [[10, 'src/old.ts']]),
      usage: [usage({ ts: at(5), command: 'check', git_head: fake })],
    });
    expect(result.totals.no_coverage).toEqual({
      new_file: 0,
      undocumented: 0,
      unclassified: 1,
    });
    expect(result.undocumented_files).toEqual([]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The tree listing is relative to a subdirectory root]]
  it('works relative to a project root below the repository root', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-sub-')));
    try {
      git(repo, 'init', '-q');
      write(repo, 'sub/src/a.ts', 'a\n');
      write(repo, 'sub/src/doc.ts', 'd\n');
      write(repo, 'other/x.ts', 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'first');
      const subHead = git(repo, 'rev-parse', 'HEAD');
      const sub = join(repo, 'sub');
      const snapshot = snapshotOf(subHead, {
        code_ref_edges: [{ file: 'sub/src/a.ts', line: 1, section: ALPHA }],
      });
      const result = await run({
        dir: sub,
        snapshots: [snapshot],
        events: sessionOf('A', [
          [10, 'sub/src/a.ts'],
          [11, 'sub/src/doc.ts'],
          [12, 'sub/src/new.ts'],
          [13, 'other/x.ts'],
        ]),
        usage: [
          usage({
            ts: at(5),
            command: 'check',
            git_head: subHead,
            repo_root: sub,
            worktree: repo,
          }),
        ],
      });
      expect(result.totals.expected_sections).toBe(1);
      expect(result.totals.no_coverage).toEqual({
        new_file: 1,
        undocumented: 1,
        unclassified: 0,
      });
      expect(result.undocumented_files).toEqual([
        { path: 'src/doc.ts', sessions: 1, edits: 1 },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A symbol-ref edge covers a file]]
  it('treats a file cited as file#symbol as covered', async () => {
    const result = await run({
      snapshots: [
        snapshotOf(head, {
          symbol_ref_edges: [{ section: BETA, file: 'src/old.ts' }],
        }),
      ],
      events: sessionOf('A', [[10, 'src/old.ts']]),
    });
    expect(outcomeOf(result, 'A', BETA)).toBe('never-consulted');
    expect(result.totals.no_coverage.undocumented).toBe(0);
    expect(result.undocumented_files).toEqual([]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A symbol-ref edge covers a file]]
  it('keeps symbol-ref edges when the code refs were not captured', async () => {
    const result = await run({
      baselineWorktree: null,
      snapshots: [
        snapshotOf(head, {
          code_ref_edges: null,
          code_ref_edges_reason: 'not_captured',
          symbol_ref_edges: [{ section: BETA, file: 'src/old.ts' }],
        }),
      ],
      events: sessionOf('A', [
        [10, 'src/old.ts'],
        [11, 'src/c.ts'],
      ]),
    });
    expect(outcomeOf(result, 'A', BETA)).toBe('never-consulted');
    expect(result.totals.no_coverage).toEqual({
      new_file: 0,
      undocumented: 0,
      unclassified: 1,
    });
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Files without a section are no-coverage]]
  it('counts a file absent from the tree as new-file without code refs', async () => {
    const result = await run({
      baselineWorktree: null,
      snapshots: [
        snapshotOf(head, {
          code_ref_edges: null,
          code_ref_edges_reason: 'not_captured',
          symbol_ref_edges: [{ section: BETA, file: 'src/old.ts' }],
        }),
      ],
      events: sessionOf('A', [
        [10, 'src/old.ts'],
        [11, 'src/c.ts'],
        [12, 'src/new.ts'],
      ]),
    });
    expect(result.totals.no_coverage).toEqual({
      new_file: 1,
      undocumented: 0,
      unclassified: 1,
    });
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The snapshot follows the earliest head of the session]]
  it('keeps the head of a session that crosses the range boundary', async () => {
    const h1 = '1'.repeat(40);
    const h2 = '2'.repeat(40);
    const options = {
      snapshots: [
        snapshotOf(h1),
        snapshotOf(h2, {
          code_ref_edges: [{ file: 'src/a.ts', line: 1, section: BETA }],
        }),
      ],
      events: sessionOf('A', EDIT_A, 0, 30 * 60),
      usage: [
        usage({ ts: at(1), command: 'check', git_head: h2 }),
        usage({ ts: at(20 * 60), command: 'check', git_head: h1 }),
      ],
    };
    const filtered = await run({
      ...options,
      filters: { from: '2026-11-09', to: '2026-11-09' },
    });
    forgetMissedKnowledge();
    const whole = await run(options);
    expect(filtered.records).toEqual(whole.records);
    expect(whole.records.map((r) => [r.section_id, r.git_head])).toEqual([
      [BETA, h2],
    ]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A recovered snapshot is seen after the snapshot cache is forgotten]]
  it('sees a recovered snapshot after forgetSnapshots', async () => {
    const later = 'f'.repeat(40);
    const events = sessionOf('A', EDIT_A, 0, 30 * 60);
    const before = await run({
      snapshots: [],
      events,
      usage: [usage({ ts: at(1), command: 'check', git_head: later })],
    });
    expect(before.totals.not_captured_sessions).toBe(1);

    forgetSnapshots();
    const after = await run({
      snapshots: [
        snapshotOf(later, {
          code_ref_edges: [{ file: 'src/a.ts', line: 1, section: BETA }],
        }),
      ],
      events,
    });
    expect(after.totals.not_captured_sessions).toBe(0);
    expect(after.records.map((r) => r.section_id)).toEqual([BETA]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A snapshot without edges is not captured]]
  it('counts a session with neither edge kind as not_captured, never a miss', async () => {
    const result = await run({
      baselineWorktree: null,
      snapshots: [
        snapshotOf(head, {
          code_ref_edges: null,
          code_ref_edges_reason: 'not_captured',
        }),
      ],
      events: sessionOf('A', EDIT_A),
    });
    expect(result.totals.not_captured_sessions).toBe(1);
    expect(result.totals.sessions_with_miss).toBe(0);
    expect(result.totals.expected_sections).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.sessions[0]).toMatchObject({
      status: 'not_captured',
      had_a_miss: false,
    });
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Lat commands join sessions by id or by time window]]
  it('joins an event without a session id by the window of the session', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', EDIT_A, 0, 30),
        ...sessionOf('B', EDIT_A, 40, 70),
      ],
      usage: [
        usage({ ts: at(1), command: 'check', session_id: 'A' }),
        usage({
          ts: at(41),
          command: 'check',
          session_id: 'B',
          worktree: '/elsewhere',
        }),
        read(5, ALPHA, { session_id: null }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('reached');
    expect(outcomeOf(result, 'B', ALPHA)).toBe('never-consulted');
    expect(result.unjoinable_events).toBe(0);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Lat commands join sessions by id or by time window]]
  it('tells overlapping sessions apart by worktree', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', EDIT_A, 0, 30),
        ...sessionOf('B', EDIT_A, 0, 30),
      ],
      usage: [
        usage({ ts: at(1), command: 'check', session_id: 'A' }),
        usage({
          ts: at(1),
          command: 'check',
          session_id: 'B',
          worktree: '/elsewhere',
        }),
        read(5, ALPHA, { session_id: null }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('reached');
    expect(outcomeOf(result, 'B', ALPHA)).toBe('never-consulted');
    expect(result.unjoinable_events).toBe(0);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Lat commands join sessions by id or by time window]]
  it('leaves out an event that matches several sessions or none', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', EDIT_A, 0, 30),
        ...sessionOf('B', EDIT_A, 0, 30),
      ],
      usage: [
        usage({ ts: at(1), command: 'check', session_id: 'A' }),
        usage({ ts: at(1), command: 'check', session_id: 'B' }),
        read(5, ALPHA, { session_id: null }),
        read(90, ALPHA, { session_id: null }),
      ],
    });
    expect(outcomeOf(result, 'A', ALPHA)).toBe('never-consulted');
    expect(outcomeOf(result, 'B', ALPHA)).toBe('never-consulted');
    expect(result.unjoinable_events).toBe(2);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The snapshot follows the earliest head of the session]]
  it('uses the snapshot at the earliest head of the session lat commands', async () => {
    const h1 = '1'.repeat(40);
    const h2 = '2'.repeat(40);
    const h3 = '3'.repeat(40);
    const onlyBeta = (gitHead: string) =>
      snapshotOf(gitHead, {
        code_ref_edges: [{ file: 'src/a.ts', line: 1, section: BETA }],
      });
    const result = await run({
      snapshots: [snapshotOf(h1), onlyBeta(h2), snapshotOf(h3)],
      events: [...sessionOf('A', EDIT_A), ...sessionOf('B', EDIT_A, 5, 60)],
      usage: [
        usage({ ts: at(1), command: 'check', git_head: h2, session_id: 'A' }),
        usage({ ts: at(2), command: 'check', git_head: h1, session_id: 'A' }),
        usage({ ts: at(30), command: 'check', git_head: h3, session_id: 'C' }),
      ],
    });
    expect(outcomeOf(result, 'A', BETA)).toBe('never-consulted');
    expect(outcomeOf(result, 'A', ALPHA)).toBeUndefined();
    expect(result.records.find((r) => r.session_id === 'A')!.git_head).toBe(h2);
    // B ran no lat command, so it takes the latest head of the range.
    expect(result.records.find((r) => r.session_id === 'B')!.git_head).toBe(h3);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The snapshot follows the earliest head of the session]]
  it('expects nothing of a file and section the session created and committed', async () => {
    const first = head;
    write(root, 'src/new.ts', '// @lat: [[notes#Notes#New]]\n');
    write(root, 'lat.md/notes.md', '# Notes\n\n## New\n\nx\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'second');
    const second = git(root, 'rev-parse', 'HEAD');
    const NEW = 'lat.md/notes#Notes#New';
    const result = await run({
      snapshots: [
        snapshotOf(first, { code_ref_edges: [] }),
        snapshotOf(second, {
          code_ref_edges: [{ file: 'src/new.ts', line: 1, section: NEW }],
          sections: [
            { id: NEW, document: 'lat.md/notes.md', bytes: 1, hash: 'h' },
          ],
        }),
      ],
      events: sessionOf('A', [[10, 'src/new.ts']], 0, 40),
      usage: [
        usage({ ts: at(1), command: 'search', git_head: first }),
        usage({ ts: at(30), command: 'check', git_head: second }),
      ],
    });
    expect(result.sessions[0]).toMatchObject({
      git_head: first,
      expected_sections: 0,
      had_a_miss: false,
      no_coverage: { new_file: 1, undocumented: 0, unclassified: 0 },
    });
    expect(result.records).toEqual([]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The snapshot follows the earliest head of the session]]
  it('is not captured when no snapshot can be found', async () => {
    const result = await run({
      baseline: false,
      snapshots: [],
      events: sessionOf('A', EDIT_A),
      usage: [usage({ ts: at(1), command: 'check', git_head: null })],
    });
    expect(result.sessions[0].status).toBe('not_captured');
    expect(result.sessions[0].reason).toMatch(/git head|snapshot/);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is reached over expected]]
  it('gives reach null with a reason when nothing is expected', async () => {
    const result = await run({
      events: sessionOf('A', [[10, 'src/old.ts']]),
    });
    expect(result.totals.expected_sections).toBe(0);
    expect(result.totals.reach).toBeNull();
    expect(result.totals.reach_reason).toMatch(/expected/);
    expect(result.sessions[0].reach).toBeNull();
    expect(result.sessions[0].had_a_miss).toBe(false);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is reached over expected]]
  it('divides reached by expected per session and per issue', async () => {
    const result = await run({
      issues: [issue('i1', 'task')],
      events: [
        claim('A', 'i1'),
        ...sessionOf('A', [
          [10, 'src/a.ts'],
          [11, 'src/c.ts'],
        ]),
      ],
      usage: [read(5, ALPHA)],
    });
    expect(result.sessions[0]).toMatchObject({
      expected_sections: 2,
      reached: 1,
      reach: 0.5,
      had_a_miss: true,
    });
    expect(result.by_issue.find((row) => row.key === 'i1')!.own.reach).toBe(
      0.5,
    );
    expect(result.totals.reach).toBe(0.5);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is split by issue type]]
  it.each(['bug', 'feature', 'task', 'chore', 'epic', 'decision'])(
    'counts a %s session under its own type',
    async (type) => {
      const result = await run({
        issues: [issue('x1', type)],
        events: [claim('A', 'x1'), ...sessionOf('A', EDIT_A)],
        usage: [read(5, ALPHA)],
      });
      expect(result.by_issue_type.map((row) => row.key)).toEqual([type]);
      expect(result.by_issue_type[0].reach).toBe(1);
    },
  );

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is split by issue type]]
  it('puts an unattributed session under unknown', async () => {
    const result = await run({ events: sessionOf('A', EDIT_A) });
    expect(result.by_issue_type.map((row) => row.key)).toEqual(['unknown']);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is split by issue type]]
  it('does not credit the type of an ancestor', async () => {
    const result = await run({
      issues: [issue('e1', 'epic'), issue('t1', 'task', 'e1')],
      events: [claim('A', 't1'), ...sessionOf('A', EDIT_A)],
    });
    expect(result.by_issue_type.map((row) => row.key)).toEqual(['task']);
    const epic = result.by_issue.find((row) => row.key === 'e1')!;
    expect(epic.own.sessions).toBe(0);
    expect(epic.rolled_up.sessions).toBe(1);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is split by issue type]]
  it('counts a session shared by two types once under each', async () => {
    const result = await run({
      issues: [issue('b1', 'bug'), issue('f1', 'feature')],
      events: [claim('A', 'b1'), claim('A', 'f1'), ...sessionOf('A', EDIT_A)],
    });
    expect(result.by_issue_type.map((row) => [row.key, row.sessions])).toEqual([
      ['bug', 1],
      ['feature', 1],
    ]);
    expect(result.totals.sessions).toBe(1);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Reach is split by agent and by session]]
  it('splits the figures by agent and by session', async () => {
    const result = await run({
      events: sessionOf('A', EDIT_A),
      codexEvents: sessionOf('B', EDIT_A),
      usage: [read(5, ALPHA, { session_id: 'B', agent: 'codex' })],
    });
    const byAgent = Object.fromEntries(
      result.by_agent.map((row) => [row.key, row.reach]),
    );
    expect(byAgent).toEqual({ claude: 0, codex: 1 });
    expect(
      result.sessions.map((s) => [s.session_id, s.agent, s.reach]),
    ).toEqual([
      ['A', 'claude', 0],
      ['B', 'codex', 1],
    ]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Every expected section has one record]]
  it('writes one record per session and expected section', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', [
          [10, 'src/a.ts'],
          [11, 'src/d.ts'],
        ]),
        ...sessionOf('B', EDIT_A),
      ],
      usage: [
        read(5, ALPHA, { session_id: 'A' }),
        read(5, ALPHA, { session_id: 'B' }),
      ],
    });
    expect(result.records).toHaveLength(3);
    expect(result.records).toContainEqual({
      session_id: 'A',
      section_id: ALPHA,
      outcome: 'reached',
      session_start: at(0),
      git_head: head,
      queries_before_first_edit: null,
    });
    const flags = Object.fromEntries(
      result.sessions.map((s) => [s.session_id, s.had_a_miss]),
    );
    expect(flags).toEqual({ A: true, B: false });
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The result carries series and lists for consumers]]
  it('buckets the daily series by the UTC date of the session start', async () => {
    const result = await run({
      events: [
        ...sessionOf('A', [[13 * 60 + 40, 'src/a.ts']], 13 * 60 + 30, 20 * 60),
        ...sessionOf('B', [[14 * 60 + 40, 'src/a.ts']], 14 * 60 + 30, 20 * 60),
      ],
      usage: [read(13 * 60 + 35, ALPHA, { session_id: 'A' })],
    });
    // T0 is 10:00 UTC, so +13:30 is 23:30 on the 8th and +14:30 is 00:30 on the 9th.
    const days = Object.fromEntries(
      result.daily.map((p) => [p.day, [p.sessions, p.reach]]),
    );
    expect(days['2026-11-08']).toEqual([1, 1]);
    expect(days['2026-11-09']).toEqual([1, 0]);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The result carries series and lists for consumers]]
  it('reports the previous range of equal length', async () => {
    const result = await run({
      filters: { from: '2026-11-08', to: '2026-11-09' },
      events: [
        ...sessionOf('P', [[-12 * 60 + 10, 'src/a.ts']], -12 * 60, -11 * 60),
        ...sessionOf('A', EDIT_A, 0, 60),
      ],
      usage: [
        read(-12 * 60 + 5, ALPHA, { session_id: 'P' }),
        usage({ ts: at(1), command: 'check', session_id: 'A' }),
      ],
    });
    expect(result.totals.sessions).toBe(1);
    expect(result.totals.reach).toBe(0);
    expect(result.previous!.sessions).toBe(1);
    expect(result.previous!.reach).toBe(1);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The result carries series and lists for consumers]]
  it('has no previous range without a from filter', async () => {
    const result = await run({ events: sessionOf('A', EDIT_A) });
    expect(result.previous).toBeNull();
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#The result names its method]]
  it('carries method_version and the two notes', async () => {
    const result = await run({ events: sessionOf('A', EDIT_A) });
    expect(result.method_version).toBe(MISSED_KNOWLEDGE_METHOD_VERSION);
    expect(result.notes.inferred_not_intended).toMatch(/inferred/);
    expect(result.notes.measures_existing_documented_code).toMatch(/existing/);
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#Every expected section has one record]]
  it('counts a session with no edits apart from the measured ones', async () => {
    const result = await run({ events: sessionOf('A', []) });
    expect(result.totals.no_edit_sessions).toBe(1);
    expect(result.totals.measured_sessions).toBe(0);
    expect(result.totals.reach).toBeNull();
  });
});

describe('readLineAt', () => {
  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A transcript line is read only from a regular file]]
  it('reads the line at an offset of a regular file', async () => {
    const path = join(root, 'session.jsonl');
    writeFileSync(path, 'first\nsecond\n');
    expect(await readLineAt(path, 6)).toBe('second');
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A transcript line is read only from a regular file]]
  it('gives no line for a symlinked transcript', async () => {
    const target = join(root, 'target.jsonl');
    writeFileSync(target, 'line\n');
    const link = join(root, 'link.jsonl');
    symlinkSync(target, link);
    expect(await readLineAt(link, 0)).toBeNull();
  });

  // @lat: [[usage-missed-knowledge#Usage Missed Knowledge#A transcript line is read only from a regular file]]
  it.skipIf(process.platform === 'win32')(
    'gives no line for a FIFO transcript and does not hang',
    async () => {
      const fifo = join(root, 'fifo.jsonl');
      execFileSync('mkfifo', [fifo]);
      expect(await readLineAt(fifo, 0)).toBeNull();
    },
    5000,
  );
});
