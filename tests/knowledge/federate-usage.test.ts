import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { federateTags } from '../../src/knowledge/index.js';
import type {
  KnowledgeHit,
  Store,
  StoreName,
} from '../../src/knowledge/types.js';
import { createAggregator } from '../../src/fork/usage/aggregate.js';
import { forgetSnapshots } from '../../src/fork/usage/graph-snapshot.js';
import {
  forgetMissedKnowledge,
  missedKnowledgeContribution,
  type MissedKnowledge,
} from '../../src/fork/usage/missed-knowledge.js';
import {
  savingsContribution,
  type SavingsEstimate,
} from '../../src/fork/usage/savings.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../../src/fork/usage/schema.js';
import type { SessionSource } from '../../src/fork/usage/sources/types.js';
import { writeUsageEvent } from '../../src/fork/usage/writer.js';

let root: string;
const savedLatUsage = process.env.LAT_USAGE;

beforeEach(() => {
  delete process.env.LAT_USAGE;
  forgetSnapshots();
  forgetMissedKnowledge();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-federate-usage-')));
});

afterEach(() => {
  if (savedLatUsage === undefined) delete process.env.LAT_USAGE;
  else process.env.LAT_USAGE = savedLatUsage;
  const usageDir = join(root, '.lat', 'usage');
  if (existsSync(usageDir)) chmodSync(usageDir, 0o755);
  rmSync(root, { recursive: true, force: true });
});

function hit(store: StoreName, key: string): KnowledgeHit {
  return { store, key, title: key, detail: 'detail', score: 1 };
}

function store(name: StoreName, hits: KnowledgeHit[], delayMs = 0): Store {
  return {
    name,
    query: () =>
      new Promise((resolve) => setTimeout(() => resolve(hits), delayMs)),
  };
}

const twoStores = () => [
  store('cq', [hit('cq', 'one'), hit('cq', 'two')]),
  store('bd', []),
];

const DOC = { id: 'lat.md/notes#Notes#Alpha', tags: ['alpha-tag', 'beta'] };

function federate(stores: Store[], deadlineMs?: number) {
  return federateTags([DOC], { projectRoot: root, stores, deadlineMs });
}

function writtenEvents(): UsageEvent[] {
  const dir = join(root, '.lat', 'usage');
  return readdirSync(dir)
    .filter((name) => /^events-.*\.jsonl$/.test(name))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf-8').trim().split('\n'),
    )
    .map((line) => JSON.parse(line) as UsageEvent);
}

const byCommand = (events: UsageEvent[], command: string) =>
  events.find((event) => event.command === command);

describe('federation usage events', () => {
  // @lat: [[fork-federate-usage#Fork Federate Usage#Each store query writes one event]]
  it('writes one event per store query when tracking is on', async () => {
    process.env.LAT_USAGE = '1';
    await federate(twoStores());
    const events = writtenEvents();
    expect(events.map((event) => event.command).sort()).toEqual([
      'federate:bd',
      'federate:cq',
    ]);
    const cq = byCommand(events, 'federate:cq')!;
    expect(cq).toMatchObject({
      schema_version: USAGE_SCHEMA_VERSION,
      surface: 'hook',
      caller: 'hook-injected',
      query: 'alpha beta',
      section_id: DOC.id,
      result_count: 2,
      found: true,
      result_ids: [],
      error_class: null,
      session_id: null,
      parent_session_id: null,
      injected_bytes: null,
      bytes_out: null,
      exit_code: 0,
      repo_root: root,
    });
    expect(cq.unknown_reasons.session_id).toBe('not_captured');
    expect(byCommand(events, 'federate:bd')).toMatchObject({
      result_count: 0,
      found: false,
    });
  });

  // @lat: [[fork-federate-usage#Fork Federate Usage#A query the deadline abandons writes one deadline event]]
  it('writes one deadline event for a store that outlasts the deadline', async () => {
    process.env.LAT_USAGE = '1';
    const slow = store('claude-memory', [hit('claude-memory', 'late')], 300);
    await federate([store('cq', []), slow], 50);
    const atDeadline = byCommand(writtenEvents(), 'federate:claude-memory')!;
    expect(atDeadline.error_class).toBe('deadline');
    expect(atDeadline.duration_ms).toBeGreaterThanOrEqual(40);
    expect(byCommand(writtenEvents(), 'federate:cq')!.error_class).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 400));
    const slowEvents = writtenEvents().filter(
      (event) => event.command === 'federate:claude-memory',
    );
    expect(slowEvents).toHaveLength(1);
  });

  // @lat: [[fork-federate-usage#Fork Federate Usage#Tracking off writes nothing]]
  it('creates no events file when tracking is off', async () => {
    const output = await federate(twoStores());
    expect(output).toContain('cq:');
    expect(existsSync(join(root, '.lat'))).toBe(false);
  });

  // @lat: [[fork-federate-usage#Fork Federate Usage#A failed write leaves federation unchanged]]
  it('returns the same output with an unwritable usage directory', async () => {
    const untracked = await federate(twoStores());
    const usageDir = join(root, '.lat', 'usage');
    mkdirSync(usageDir, { recursive: true });
    chmodSync(usageDir, 0o500);
    process.env.LAT_USAGE = '1';
    await expect(federate(twoStores())).resolves.toBe(untracked);
  });
});

function usage(fields: Partial<UsageEvent>): UsageEvent {
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u-${Math.random()}`,
    ts: '2026-11-08T10:05:00.000Z',
    duration_ms: 10,
    command: 'hook claude UserPromptSubmit',
    surface: 'hook',
    caller: 'hook-injected',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: null,
    parent_session_id: null,
    repo_root: root,
    git_head: null,
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

const federateEvent = (store: StoreName, fields: Partial<UsageEvent> = {}) =>
  usage({
    command: `federate:${store}`,
    section_id: DOC.id,
    result_count: 1,
    found: true,
    ...fields,
  });

function sourceOf(events: SessionEvent[]): SessionSource {
  return {
    agent: 'claude',
    discover: async () => (events.length ? ['/fake/claude.jsonl'] : []),
    read: async () => ({
      events,
      checkpoint: { offset: events.length },
      reason: null,
    }),
  };
}

async function summaryOf(events: UsageEvent[], sessions: SessionEvent[] = []) {
  for (const event of events) writeUsageEvent(root, event);
  const aggregator = await createAggregator({
    root,
    sources: [sourceOf(sessions)],
    bd: { refresh: async () => null },
    contributions: [savingsContribution, missedKnowledgeContribution],
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await aggregator.refresh();
  return aggregator.summary();
}

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

function sessionEvent(
  kind: SessionEvent['kind'],
  ts: string,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return {
    kind,
    event_id: `s-${kind}-${ts}`,
    session_id: 'A',
    ts,
    source: { path: '/fake/A.jsonl', offset: Date.parse(ts) },
    ...extra,
  } as SessionEvent;
}

describe('federation events in aggregation', () => {
  // @lat: [[fork-federate-usage#Fork Federate Usage#Federation events are not injections]]
  it('counts only the hook event as an injection', async () => {
    const summary = await summaryOf([
      usage({ injected_bytes: 100 }),
      federateEvent('cq'),
      federateEvent('bd', { result_count: 0, found: false }),
    ]);
    expect(summary.totals.injected_events).toBe(1);
    const savings = summary.extensions[
      savingsContribution.key
    ] as SavingsEstimate;
    expect(savings.injected_bytes).toEqual({
      total: 100,
      known: 1,
      unknown: 0,
    });
    expect(savings.unknown_reads).toEqual([]);
  });

  // @lat: [[fork-federate-usage#Fork Federate Usage#Federation events are not reads]]
  it('does not count a federation event as a read or as unjoinable', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('lat.md/notes.md', '# Notes\n\n## Alpha\n\nAlpha text.\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const head = git('rev-parse', 'HEAD');
    write(
      `.lat/usage/graph-snapshots/${head}.json`,
      JSON.stringify({
        git_head: head,
        sections: [
          { id: DOC.id, document: 'lat.md/notes.md', bytes: 10, hash: 'h' },
        ],
        documents: [{ path: 'lat.md/notes.md', bytes: 100 }],
        code_ref_edges: [{ file: 'src/a.ts', line: 1, section: DOC.id }],
        code_ref_edges_reason: null,
        symbol_ref_edges: [],
      }),
    );
    const sessions = [
      sessionEvent('session_start', '2026-11-08T10:00:00.000Z'),
      sessionEvent('token_usage', '2026-11-08T10:00:01.000Z', {
        usage: {
          input: null,
          output: null,
          cache_read: null,
          cache_write: null,
          reasoning: null,
        },
      }),
      sessionEvent('tool_call', '2026-11-08T10:10:00.000Z', {
        tool: { name: 'Edit', action: 'edit', path: 'src/a.ts', bytes: null },
      }),
      sessionEvent('session_end', '2026-11-08T11:00:00.000Z'),
    ];
    const summary = await summaryOf(
      [
        usage({
          ts: '2026-11-08T09:59:00.000Z',
          command: 'check',
          surface: 'cli',
          caller: 'human',
          agent: null,
          git_head: head,
        }),
        federateEvent('cq', { git_head: head }),
        federateEvent('bd', { git_head: head, ts: '2026-11-08T12:00:00.000Z' }),
      ],
      sessions,
    );
    const missed = summary.extensions[
      missedKnowledgeContribution.key
    ] as MissedKnowledge;
    const record = missed.records.find(
      (entry) => entry.session_id === 'A' && entry.section_id === DOC.id,
    );
    expect(record?.outcome).toBe('never-consulted');
    expect(missed.unjoinable_events).toBe(0);
  });
});
