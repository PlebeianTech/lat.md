import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAggregator,
  type Aggregator,
  type Contribution,
  type UsageSummary,
} from '../src/fork/usage/aggregate.js';
import { parseUsageFilters } from '../src/fork/usage/filters.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import type { BdIssue } from '../src/fork/usage/bd-client.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type TokenUsage,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type {
  Checkpoint,
  SessionAgent,
  SessionSource,
} from '../src/fork/usage/sources/types.js';
import {
  addSessionEvent,
  addUsageEvent,
  emptyState,
} from '../src/fork/usage/state.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const DAY = 24 * 60;

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-usage-aggregate-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

let counter = 0;
function usage(fields: Partial<UsageEvent>): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${counter}`,
    ts: at(0),
    duration_ms: 100,
    command: 'search',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: '/repo',
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

type SessionKind = SessionEvent['kind'];
function session(
  kind: SessionKind,
  sessionId: string,
  minutes: number,
  extra: Record<string, unknown> = {},
  parent?: string,
): SessionEvent {
  counter++;
  return {
    kind,
    event_id: `s${counter}`,
    session_id: sessionId,
    ts: at(minutes),
    source: { path: `/fake/${sessionId}.jsonl`, offset: counter },
    ...(parent ? { parent_session_id: parent } : {}),
    ...extra,
  } as SessionEvent;
}

function tokens(
  sessionId: string,
  minutes: number,
  usageFields: Partial<TokenUsage>,
  parent?: string,
): SessionEvent {
  return session(
    'token_usage',
    sessionId,
    minutes,
    {
      usage: {
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        reasoning: null,
        ...usageFields,
      },
    },
    parent,
  );
}

interface FakeSource extends SessionSource {
  calls: (Checkpoint | null)[];
  events: SessionEvent[];
}

function fakeSource(
  agent: SessionAgent,
  events: SessionEvent[],
  options: { reemit?: boolean; reason?: 'not_captured' } = {},
): FakeSource {
  const calls: (Checkpoint | null)[] = [];
  return {
    agent,
    calls,
    events,
    discover: async () => [`/fake/${agent}.jsonl`],
    read: async (_path, checkpoint) => {
      calls.push(checkpoint);
      const start = options.reemit ? 0 : (checkpoint?.offset ?? 0);
      return {
        events: events.slice(start),
        checkpoint: { offset: events.length },
        reason: options.reason ?? null,
      };
    },
  };
}

function issue(id: string, parent?: string): BdIssue {
  return {
    id,
    title: `title ${id}`,
    status: 'open',
    issue_type: parent ? 'task' : 'epic',
    created_at: at(-1000),
    ...(parent ? { parent } : {}),
  };
}

const SNAPSHOT: BdSnapshot = {
  issues: [issue('lat-1'), issue('lat-1.1', 'lat-1'), issue('lat-2')],
  discoveredFrom: [],
  reopens: [],
};

function bdSnapshot(snapshot: BdSnapshot | null = SNAPSHOT) {
  return { refresh: async () => snapshot };
}

const SEC = {
  one: 'docs/a#One',
  two: 'docs/a#Two',
  three: 'docs/b#Three',
  nine: 'docs/b#Nine',
};

/** The usage events of the main scenario; see the comments for what each proves. */
function scenarioUsage(): UsageEvent[] {
  return [
    usage({
      event_id: 'e1',
      ts: at(0),
      query: 'Foo Bar',
      result_ids: [SEC.one, SEC.two, SEC.three],
      result_count: 3,
      bytes_out: 1000,
    }),
    // follows e1, rank 2
    usage({
      event_id: 'e2',
      ts: at(0.5),
      command: 'section',
      section_id: SEC.two,
      duration_ms: 200,
    }),
    usage({
      event_id: 'e3',
      ts: at(10),
      query: 'foo  bar',
      result_ids: [SEC.nine],
      result_count: 1,
    }),
    // within 60 seconds of e3: e3 is reformulated
    usage({
      event_id: 'e4',
      ts: at(10.5),
      query: 'baz',
      result_ids: [],
      result_count: 0,
    }),
    // the latest earlier search (e4) has no results: not followed
    usage({
      event_id: 'e5',
      ts: at(11),
      command: 'section',
      section_id: SEC.one,
    }),
    // subagent of A, no search of its own
    usage({
      event_id: 'e6',
      ts: at(1),
      command: 'section',
      section_id: SEC.three,
      session_id: 'A1',
      parent_session_id: 'A',
    }),
    usage({
      event_id: 'e7',
      ts: at(20),
      command: 'hook claude PostToolUse',
      surface: 'hook',
      caller: 'hook-injected',
      section_id: SEC.one,
      injected_bytes: 500,
    }),
    usage({
      event_id: 'e8',
      ts: at(DAY),
      agent: 'codex',
      session_id: 'B',
      query: 'foo bar',
      result_ids: [SEC.two],
      result_count: null,
      duration_ms: 300,
    }),
    usage({
      event_id: 'e9',
      ts: at(DAY + 1),
      agent: 'codex',
      session_id: 'B',
      command: 'section',
      section_id: SEC.two,
      exit_code: 1,
      error_class: 'nonzero_exit',
    }),
    usage({
      event_id: 'e10',
      ts: at(120),
      agent: null,
      caller: 'human',
      session_id: null,
      query: 'foo bar',
      result_ids: [SEC.one, SEC.two],
      result_count: 2,
    }),
  ];
}

function scenarioClaude(): SessionEvent[] {
  return [
    session('bd_command', 'A', -1, { verb: 'claim', issue_id: 'lat-1.1' }),
    session('bd_command', 'A', -1, { verb: 'claim', issue_id: 'lat-2' }),
    session('bd_command', 'A', 5, { verb: 'close', issue_id: 'lat-1.1' }),
    session('bd_command', 'A', 5, { verb: 'close', issue_id: 'lat-2' }),
    session('session_start', 'A', 0),
    session('session_name', 'A', 1, { name: 'alpha' }),
    session('model', 'A', 1, { model: 'm1' }),
    tokens('A', 1, { input: 100, output: 50 }),
    session('bypass_read', 'A', 12, { path: 'lat.md/foo.md', bytes: 10 }),
    tokens('A', 12, { input: 200 }),
    session('session_end', 'A', 20),
    session('session_start', 'A1', 1, {}, 'A'),
    tokens('A1', 2, { input: 10, output: 5 }, 'A'),
    // the reader re-emits these on a resumed read with new ids
    session('session_name', 'A', 25, { name: 'alpha2' }),
    session('model', 'A', 25, { model: 'm2' }),
    session('session_end', 'A', 25),
  ];
}

function scenarioCodex(): SessionEvent[] {
  return [
    session('session_start', 'B', DAY),
    tokens('B', DAY + 1, {}),
    session('session_end', 'B', DAY + 5),
  ];
}

function writeLog(root: string, events: UsageEvent[]) {
  for (const event of events) writeUsageEvent(root, event);
}

interface Setup {
  root: string;
  claude: FakeSource;
  codex: FakeSource;
  pi: FakeSource;
  aggregator: Aggregator;
}

async function setup(
  options: {
    root?: string;
    usageEvents?: UsageEvent[];
    claudeEvents?: SessionEvent[];
    codexEvents?: SessionEvent[];
    reemit?: boolean;
    contributions?: Contribution[];
    snapshot?: BdSnapshot | null;
  } = {},
): Promise<Setup> {
  const root = options.root ?? tempRoot();
  writeLog(root, options.usageEvents ?? scenarioUsage());
  const claude = fakeSource(
    'claude',
    options.claudeEvents ?? scenarioClaude(),
    {
      reemit: options.reemit,
    },
  );
  const codex = fakeSource('codex', options.codexEvents ?? scenarioCodex(), {
    reemit: options.reemit,
  });
  const pi = fakeSource('pi', [], { reason: 'not_captured' });
  const aggregator = await createAggregator({
    root,
    sources: [claude, codex, pi],
    bd: bdSnapshot(options.snapshot),
    contributions: options.contributions ?? [],
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await aggregator.refresh();
  return { root, claude, codex, pi, aggregator };
}

function row<T extends { key: string }>(rows: T[], key: string): T {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key} in ${rows.map((r) => r.key)}`);
  return found;
}

describe('usage aggregate', () => {
  // @lat: [[usage-aggregate#Usage Aggregate#Feeding the same events twice changes nothing]]
  it('gives the same summary when the same events are fed twice', async () => {
    const once = await setup();
    const first = await once.aggregator.summary();
    writeLog(once.root, scenarioUsage().slice(0, 4));
    writeLog(once.root, [...scenarioUsage()]);
    await once.aggregator.refresh();
    expect(await once.aggregator.summary()).toEqual(first);

    const reemitting = await setup({ reemit: true });
    const before = await reemitting.aggregator.summary();
    await reemitting.aggregator.refresh();
    await reemitting.aggregator.refresh();
    expect(await reemitting.aggregator.summary()).toEqual(before);
    expect(before.totals.commands).toBe(9);
    expect(before.totals.tokens.messages).toBe(4);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Summaries are memoized per data version]]
  it('serves an identical summary from one computation until the data changes', async () => {
    let computes = 0;
    const counting: Contribution = {
      key: 'count',
      compute: async () => ++computes,
    };
    const root = tempRoot();
    const { aggregator } = await setup({ root, contributions: [counting] });
    const [first, second] = await Promise.all([
      aggregator.summary(),
      aggregator.summary(),
    ]);
    expect(second).toBe(first);
    expect(computes).toBe(1);

    await aggregator.refresh();
    expect(await aggregator.summary({})).toBe(first);
    expect(computes).toBe(1);

    await aggregator.summary(parseUsageFilters({ agent: 'codex' }));
    expect(computes).toBe(2);

    writeLog(root, [usage({ ts: at(30) })]);
    await aggregator.refresh();
    const fresh = await aggregator.summary();
    expect(fresh).not.toBe(first);
    expect(fresh.totals.commands).toBe(first.totals.commands + 1);
    expect(computes).toBe(3);

    aggregator.invalidate();
    expect(await aggregator.summary()).not.toBe(fresh);
    expect(computes).toBe(4);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A memo computed across a reset is not cached]]
  it('answers a memo caller across resets without caching the result', async () => {
    const { aggregator } = await setup();
    const gates: (() => void)[] = [];
    let runs = 0;
    const slow = () => {
      const run = ++runs;
      return new Promise<number>((resolve) => gates.push(() => resolve(run)));
    };
    const pending = aggregator.memo('slow', slow);
    aggregator.invalidate();
    aggregator.invalidate();
    gates[0]();
    expect(await pending).toBe(1);
    expect(runs).toBe(1);
    const later = aggregator.memo('slow', slow);
    gates[1]();
    expect(await later).toBe(2);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A summary ignores a refresh in progress]]
  it('keeps the agent reasons of the data version a summary was built from', async () => {
    const root = tempRoot();
    writeLog(root, [usage({ ts: at(0) })]);
    let reason: 'not_captured' | null = null;
    const source: SessionSource = {
      agent: 'claude',
      discover: async () => ['/fake/claude.jsonl'],
      read: async () => ({
        events: [],
        checkpoint: { offset: 0 },
        reason,
      }),
    };
    let gate: Promise<void> = Promise.resolve();
    const aggregator = await createAggregator({
      root,
      sources: [source],
      bd: { refresh: async () => (await gate, null) },
      contributions: [],
      now: () => Date.parse('2026-11-10T00:00:00Z'),
    });
    await aggregator.refresh();
    reason = 'not_captured';
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    // The refresh has read the new reason and now waits for bd.
    const refreshing = aggregator.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const during = await aggregator.summary();
    release();
    await refreshing;
    expect(row(during.agents, 'claude').reason).toBeNull();
    expect(row((await aggregator.summary()).agents, 'claude').reason).toBe(
      'not_captured',
    );
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A restart resumes from state.json]]
  it('resumes from state.json and matches an uninterrupted run', async () => {
    const root = tempRoot();
    const all = scenarioUsage();
    const claudeAll = scenarioClaude();
    const early = await setup({
      root,
      usageEvents: all.slice(0, 5),
      claudeEvents: claudeAll.slice(0, 8),
      codexEvents: [],
    });
    expect(
      statSync(join(root, '.lat', 'usage', 'state.json')).size,
    ).toBeGreaterThan(0);

    writeLog(root, all.slice(5));
    early.claude.events.push(...claudeAll.slice(8));
    early.codex.events.push(...scenarioCodex());

    const resumedClaude = fakeSource('claude', early.claude.events);
    const resumedCodex = fakeSource('codex', early.codex.events);
    const resumed = await createAggregator({
      root,
      sources: [
        resumedClaude,
        resumedCodex,
        fakeSource('pi', [], { reason: 'not_captured' }),
      ],
      bd: bdSnapshot(),
      contributions: [],
      now: () => Date.parse('2026-11-10T00:00:00Z'),
    });
    await resumed.refresh();
    expect(resumedClaude.calls[0]).toEqual({ offset: 8 });

    const uninterrupted = await setup();
    expect(await resumed.summary()).toEqual(
      await uninterrupted.aggregator.summary(),
    );
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A session event with an unreadable time is dropped]]
  it('drops a session event whose ts is not a date, also after a restart', async () => {
    const root = tempRoot();
    const bad = { ...tokens('C1', 1, { input: 5 }), ts: 'not-a-date' };
    const first = await setup({
      root,
      claudeEvents: [...scenarioClaude(), bad],
    });
    const summary = await first.aggregator.summary();
    const restarted = await createAggregator({
      root,
      sources: [fakeSource('claude', [])],
      bd: bdSnapshot(),
      contributions: [],
      now: () => Date.parse('2026-11-10T00:00:00Z'),
    });
    await restarted.refresh();
    expect((await restarted.summary()).totals).toEqual(summary.totals);
    expect(
      readFileSync(join(root, '.lat', 'usage', 'state.json'), 'utf-8'),
    ).not.toContain(bad.event_id);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#An event dated out of range is dropped]]
  it('drops usage lines and session events dated before 2000 or far in the future', async () => {
    const future = '3000-01-01T00:00:00.000Z';
    const ancient = '0001-01-01T00:00:00.000Z';
    const { root, aggregator } = await setup({
      claudeEvents: [
        ...scenarioClaude(),
        {
          ...tokens('C1', 1, { input: 5 }),
          event_id: 'far-session',
          ts: future,
        },
        {
          ...tokens('C1', 1, { input: 5 }),
          event_id: 'old-session',
          ts: ancient,
        },
      ],
    });
    const before = await aggregator.summary();
    appendFileSync(
      join(root, '.lat', 'usage', 'events-2026-11.jsonl'),
      [
        usage({ event_id: 'far-usage', ts: future }),
        usage({ event_id: 'old-usage', ts: ancient }),
      ]
        .map((event) => JSON.stringify(event) + '\n')
        .join(''),
    );
    await aggregator.refresh();
    const after = await aggregator.summary();
    expect(after.totals).toEqual(before.totals);
    expect(after.days.length).toBeLessThan(10);
    const state = readFileSync(
      join(root, '.lat', 'usage', 'state.json'),
      'utf-8',
    );
    expect(state).not.toMatch(/far-|old-/);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A usage line of the wrong shape is dropped]]
  it('drops usage lines with a wrong schema version or field type', async () => {
    const { root, aggregator } = await setup();
    const before = await aggregator.summary();
    const { section_id: _, ...noSectionId } = usage({
      event_id: 'bad-missing',
    });
    const bad: object[] = [
      usage({ event_id: 'bad-version', schema_version: 2 as 1 }),
      { ...usage({ event_id: 'bad-query' }), query: 5 },
      { ...usage({ event_id: 'bad-session' }), session_id: { a: 1 } },
      {
        ...usage({ event_id: 'bad-section', command: 'section' }),
        section_id: 7,
      },
      { ...usage({ event_id: 'bad-results' }), result_ids: [1, null] },
      { ...usage({ event_id: 'bad-agent' }), agent: 3 },
      { ...usage({ event_id: 'bad-reasons' }), unknown_reasons: null },
      { ...usage({ event_id: 'bad-exit' }), exit_code: 'x' },
      { ...noSectionId, command: 'section' },
    ];
    const good = usage({ event_id: 'good', ts: at(1) });
    appendFileSync(
      join(root, '.lat', 'usage', 'events-2026-11.jsonl'),
      [...bad, good].map((event) => JSON.stringify(event) + '\n').join(''),
    );
    await aggregator.refresh();
    const after = await aggregator.summary();
    expect(after.totals.commands).toBe(before.totals.commands + 1);
    const state = readFileSync(
      join(root, '.lat', 'usage', 'state.json'),
      'utf-8',
    );
    expect(state).toContain('"good"');
    expect(state).not.toContain('bad-');
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Turning usage off empties the summary]]
  it('serves an empty summary after usage is disabled and resumes on enable', async () => {
    const { root, aggregator } = await setup();
    const before = await aggregator.summary();
    expect(before.totals.commands).toBeGreaterThan(0);
    const dir = join(root, '.lat', 'usage');
    renameSync(dir, `${dir}.disabled`);
    await aggregator.refresh();
    const off = await aggregator.summary();
    expect(off.totals.commands).toBe(0);
    expect(off.commands).toEqual([]);
    renameSync(`${dir}.disabled`, dir);
    await aggregator.refresh();
    expect(await aggregator.summary()).toEqual(before);
  });

  it('reads a log that shrank again without double counting', async () => {
    const root = tempRoot();
    const { aggregator } = await setup({ root });
    const before = await aggregator.summary();
    rmSync(join(root, '.lat', 'usage', 'events-2026-11.jsonl'));
    writeLog(root, scenarioUsage().slice(0, 2));
    await aggregator.refresh();
    const after = await aggregator.summary();
    expect(after.totals.commands).toBe(before.totals.commands);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Latest wins for repeated session events]]
  it('keeps the latest session_end, model and name per session', async () => {
    const { aggregator } = await setup();
    const a = row((await aggregator.summary()).sessions, 'A');
    expect(a.name).toBe('alpha2');
    expect(a.model).toBe('m2');
    expect(a.start).toBe(at(0));
    expect(a.end).toBe(at(25));
    expect(a.duration_ms).toBe(25 * 60_000);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Latest wins for repeated session events]]
  it('replaces a token usage re-emitted with the same id and a later ts', () => {
    const state = emptyState();
    const partial = tokens('A', 1, { output: 5 });
    const final = {
      ...tokens('A', 2, { output: 253 }),
      event_id: partial.event_id,
    };
    expect(addSessionEvent(state, 'claude', partial)).toBe(true);
    expect(addSessionEvent(state, 'claude', final)).toBe(true);
    expect(addSessionEvent(state, 'claude', partial)).toBe(false);
    const kept = Object.values(state.sessions).map((s) => s.event);
    expect(kept).toHaveLength(1);
    expect(kept[0].kind === 'token_usage' && kept[0].usage.output).toBe(253);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#An event id never collides with an object property]]
  it('keeps events whose ids are __proto__ and constructor', () => {
    const state = emptyState();
    for (const id of ['__proto__', 'constructor']) {
      const fromSession = { ...tokens('A', 1, { output: 5 }), event_id: id };
      expect(addSessionEvent(state, 'claude', fromSession)).toBe(true);
      expect(addSessionEvent(state, 'claude', fromSession)).toBe(false);
      expect(addUsageEvent(state, usage({ event_id: id }))).toBe(true);
      expect(addUsageEvent(state, usage({ event_id: id }))).toBe(false);
    }
    for (const stored of [state.sessions, state.usage])
      expect(Object.keys(stored).sort()).toEqual(['__proto__', 'constructor']);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#All five agents are listed]]
  it('lists all five agents, with zero counts and reasons', async () => {
    const summary = await (await setup()).aggregator.summary();
    expect(summary.agents.map((a) => a.key)).toEqual([
      'claude',
      'codex',
      'pi',
      'opencode',
      'antigravity',
      'unknown',
    ]);
    const claude = row(summary.agents, 'claude');
    expect(claude.totals.commands).toBe(6);
    expect(claude.totals.sessions).toBe(2);
    const codex = row(summary.agents, 'codex');
    expect(codex.totals.commands).toBe(2);
    expect(codex.totals.sessions).toBe(1);
    for (const key of ['pi', 'opencode', 'antigravity']) {
      const empty = row(summary.agents, key);
      expect(empty.totals.commands).toBe(0);
      expect(empty.totals.sessions).toBe(0);
      expect(empty.signals.lat_commands_per_session).toBeNull();
    }
    expect(row(summary.agents, 'pi').reason).toBe('not_captured');
    expect(claude.reason).toBeNull();
    expect(row(summary.agents, 'unknown').totals.commands).toBe(1);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#An agent name never collides with an object property]]
  it('lists agents named constructor, toString and __proto__ with no reason', async () => {
    const names = ['constructor', 'toString', '__proto__'];
    const { aggregator } = await setup({
      usageEvents: names.map((agent) => usage({ agent })),
      claudeEvents: [],
      codexEvents: [],
    });
    const { agents } = await aggregator.summary();
    for (const name of names) {
      expect(row(agents, name).totals.commands).toBe(1);
      expect(row(agents, name).reason).toBeNull();
    }
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Sessions keep children separate]]
  it('keeps subagent sessions as separate rows with rolled-up parents', async () => {
    const { sessions } = await (await setup()).aggregator.summary();
    expect(sessions.map((s) => s.key).sort()).toEqual(['A', 'A1', 'B']);
    const parent = row(sessions, 'A');
    const child = row(sessions, 'A1');
    expect(parent.parent_session_id).toBeNull();
    expect(child.parent_session_id).toBe('A');
    expect(parent.agent).toBe('claude');
    expect(parent.totals.commands).toBe(5);
    expect(child.totals.commands).toBe(1);
    expect(parent.rolled_up.totals.commands).toBe(6);
    expect(child.rolled_up.totals.commands).toBe(1);
    expect(parent.totals.tokens.input.total).toBe(300);
    expect(parent.rolled_up.totals.tokens.input.total).toBe(310);
    expect(parent.totals.bypass_reads).toBe(1);
    expect(parent.issues).toEqual(['lat-1.1', 'lat-2']);
    expect(child.issues).toEqual(['lat-1.1', 'lat-2']);
    expect(child.start).toBe(at(1));
    expect(child.end).toBeNull();
    expect(child.duration_ms).toBeNull();
    expect(row(sessions, 'B').agent).toBe('codex');
    expect(parent.signals.lat_commands_per_session).toBe(5);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Issues carry own and rolled-up totals]]
  it('reports own and rolled-up issue totals and an unattributed row', async () => {
    const summary = await (await setup()).aggregator.summary();
    const child = row(summary.issues, 'lat-1.1');
    const epic = row(summary.issues, 'lat-1');
    expect(child.label).toBe('title lat-1.1');
    expect(child.totals.commands).toBe(3);
    expect(child.rolled_up.totals.commands).toBe(3);
    expect(epic.totals.commands).toBe(0);
    expect(epic.rolled_up.totals.commands).toBe(3);
    expect(child.totals.tokens.messages).toBe(2);
    expect(summary.unattributed.totals.commands).toBe(6);
    expect(summary.unattributed.key).toBe('unattributed');
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Issues carry own and rolled-up totals]]
  it('reports the bd parent of an issue even when its id is not dotted', async () => {
    const snapshot: BdSnapshot = {
      ...SNAPSHOT,
      issues: [
        issue('lat-1'),
        issue('lat-1.1', 'lat-1'),
        issue('lat-2', 'lat-1'),
      ],
    };
    const summary = await (await setup({ snapshot })).aggregator.summary();
    expect(row(summary.issues, 'lat-1.1').parent).toBe('lat-1');
    expect(row(summary.issues, 'lat-2').parent).toBe('lat-1');
    expect(row(summary.issues, 'lat-1').parent).toBeNull();
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Issues carry own and rolled-up totals]]
  it('counts a shared event in full per issue but once in the grand total', async () => {
    const summary = await (await setup()).aggregator.summary();
    const first = row(summary.issues, 'lat-1.1').totals.commands;
    const second = row(summary.issues, 'lat-2').totals.commands;
    expect(first).toBe(3);
    expect(second).toBe(3);
    expect(summary.totals.commands).toBe(9);
    const issueSum = summary.issues.reduce((n, r) => n + r.totals.commands, 0);
    expect(issueSum + summary.unattributed.totals.commands).toBeGreaterThan(
      summary.totals.commands,
    );
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Commands and days]]
  it('breaks totals down by command and by UTC day', async () => {
    const summary = await (await setup()).aggregator.summary();
    expect(summary.commands.map((c) => [c.key, c.totals.commands])).toEqual([
      ['search', 5],
      ['section', 4],
    ]);
    expect(summary.byDay.map((d) => [d.key, d.totals.commands])).toEqual([
      ['2026-11-08', 7],
      ['2026-11-09', 2],
    ]);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Queries are normalized]]
  it('builds one row per normalized query', async () => {
    const { queries } = await (await setup()).aggregator.summary();
    expect(queries.map((q) => q.key)).toEqual(['foo bar', 'baz']);
    const foo = row(queries, 'foo bar');
    expect(foo.count).toBe(4);
    expect(foo.sessions).toBe(2);
    expect(foo.result_count).toBe(2);
    expect(foo.empty_share).toBe(0);
    expect(foo.follow_through_share).toBe(0.5);
    expect(foo.median_rank_opened).toBe(1.5);
    expect(foo.reformulations).toBe(1);
    expect(foo.sections_returned).toEqual([
      { section_id: SEC.two, returned: 3, opened: 2 },
      { section_id: SEC.one, returned: 2, opened: 0 },
      { section_id: SEC.nine, returned: 1, opened: 0 },
      { section_id: SEC.three, returned: 1, opened: 0 },
    ]);
    const baz = row(queries, 'baz');
    expect(baz.empty_share).toBe(1);
    expect(baz.follow_through_share).toBe(0);
    expect(baz.median_rank_opened).toBeNull();
    expect(baz.reformulations).toBe(0);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Another search within 60 seconds is a reformulation]]
  it('counts a search as reformulated only within 60 seconds in the same session', async () => {
    const search = (id: string, seconds: number, sessionId: string) =>
      usage({
        event_id: id,
        ts: at(seconds / 60),
        session_id: sessionId,
        query: id,
        result_count: 1,
      });
    const { aggregator } = await setup({
      usageEvents: [
        search('s0', 0, 'A'),
        search('s1', 60, 'A'),
        search('s2', 121, 'A'),
        search('s3', 130, 'B'),
      ],
      claudeEvents: [],
      codexEvents: [],
    });
    const summary = await aggregator.summary();
    expect(summary.totals.reformulated_searches).toBe(1);
    expect(row(summary.queries, 's0').reformulations).toBe(1);
    expect(row(summary.queries, 's1').reformulations).toBe(0);
    expect(row(summary.queries, 's3').reformulations).toBe(0);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A query row carries its opened ranks and reformulation targets]]
  it('carries the opened ranks and reformulation targets on each query row', async () => {
    const { aggregator } = await setup({
      usageEvents: [
        usage({
          event_id: 'q1',
          ts: at(0),
          query: 'Alpha',
          result_ids: ['d#x', 'd#y'],
        }),
        usage({
          event_id: 'q1r1',
          ts: at(0.1),
          command: 'section',
          section_id: 'd#y',
        }),
        usage({
          event_id: 'q1r2',
          ts: at(0.2),
          command: 'section',
          section_id: 'd#y',
        }),
        usage({ event_id: 'q2', ts: at(0.5), query: 'beta', result_ids: [] }),
        usage({ event_id: 'q3', ts: at(0.6), query: null }),
        usage({
          event_id: 'q4',
          ts: at(5),
          query: 'alpha',
          result_ids: ['d#x'],
        }),
        usage({ event_id: 'q5', ts: at(5.5), query: 'beta', result_ids: [] }),
        // the latest search is beta's q5, which does not return d#x: no rank
        usage({
          event_id: 'q5r',
          ts: at(5.6),
          command: 'section',
          section_id: 'd#x',
        }),
      ],
      claudeEvents: [],
      codexEvents: [],
    });
    const { queries } = await aggregator.summary();
    const alpha = row(queries, 'alpha');
    expect(alpha.facts.opened_ranks).toEqual({ 'd#y': [2, 2] });
    expect(alpha.facts.reformulated_to).toEqual([{ query: 'beta', count: 2 }]);
    const beta = row(queries, 'beta');
    expect(beta.facts.opened_ranks).toEqual({});
    expect(beta.facts.reformulated_to).toEqual([{ query: null, count: 1 }]);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A section id never collides with an object property]]
  it('keeps section ids such as __proto__ and constructor as plain keys', async () => {
    const { aggregator } = await setup({
      usageEvents: [
        usage({
          event_id: 'p1',
          ts: at(0),
          query: 'planted',
          result_ids: ['__proto__', 'constructor', 'toString'],
        }),
        usage({
          event_id: 'p1r1',
          ts: at(0.1),
          command: 'section',
          section_id: 'constructor',
        }),
        usage({
          event_id: 'p1r2',
          ts: at(0.2),
          command: 'section',
          section_id: '__proto__',
        }),
        usage({
          event_id: 'p1r3',
          ts: at(0.3),
          command: 'section',
          section_id: 'constructor',
        }),
      ],
      claudeEvents: [],
      codexEvents: [],
    });
    const { queries } = await aggregator.summary();
    const planted = row(queries, 'planted');
    expect(Object.entries(planted.facts.opened_ranks)).toEqual([
      ['constructor', [2, 2]],
      ['__proto__', [1]],
    ]);
    expect(Object.getPrototypeOf(planted.facts.opened_ranks)).toBe(
      Object.prototype,
    );
    // The summary crosses the API as JSON; the own keys must survive it.
    const sent = JSON.parse(JSON.stringify(planted.facts.opened_ranks));
    expect(Object.hasOwn(sent, '__proto__')).toBe(true);
    expect(Object.hasOwn(sent, 'constructor')).toBe(true);
    expect(Object.hasOwn(sent, 'toString')).toBe(false);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Query facts pair reads over the whole log]]
  it('pairs a read with the latest search of the whole log under a filter', async () => {
    // One session: claude searches X (returns d#x), codex searches Y (returns
    // nothing), claude reads d#x. The latest search before the read is Y, so
    // the read follows nothing. A replay over the claude events alone would
    // pair it with X and credit X with rank 1.
    const { aggregator } = await setup({
      usageEvents: [
        usage({
          event_id: 'f1',
          ts: at(0),
          query: 'xray',
          result_ids: ['d#x'],
        }),
        usage({
          event_id: 'f2',
          ts: at(0.2),
          agent: 'codex',
          query: 'yankee',
          result_ids: [],
        }),
        usage({
          event_id: 'f3',
          ts: at(0.4),
          command: 'section',
          section_id: 'd#x',
        }),
      ],
      claudeEvents: [],
      codexEvents: [],
    });
    const { queries } = await aggregator.summary({ agent: 'claude' });
    expect(queries.map((q) => q.key)).toEqual(['xray']);
    const xray = row(queries, 'xray');
    expect(xray.facts.opened_ranks).toEqual({});
    expect(xray.follow_through_share).toBe(0);
    expect(xray.facts.reformulated_to).toEqual([{ query: 'yankee', count: 1 }]);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A read follows only the latest earlier search]]
  it('follows a search only when the latest earlier search of the session returned the section', async () => {
    const { aggregator } = await setup({
      usageEvents: [
        usage({
          event_id: 'a1',
          ts: at(0),
          query: 'one',
          result_ids: ['d#x', 'd#y'],
        }),
        usage({ event_id: 'a2', ts: at(1), query: 'two', result_ids: ['d#z'] }),
        usage({
          event_id: 'b1',
          ts: at(1.5),
          session_id: 'B',
          query: 'other',
          result_ids: ['d#y'],
        }),
        // y is in a1 and in B's search, but not in A's latest search a2
        usage({
          event_id: 'r1',
          ts: at(2),
          command: 'section',
          section_id: 'd#y',
        }),
        usage({
          event_id: 'r2',
          ts: at(3),
          command: 'section',
          section_id: 'd#z',
        }),
      ],
      claudeEvents: [],
      codexEvents: [],
    });
    const summary = await aggregator.summary();
    expect(summary.totals.section_reads).toBe(2);
    expect(summary.totals.followed_searches).toBe(1);
    expect(summary.totals.median_rank_opened).toBe(1);
    expect(row(summary.queries, 'two').median_rank_opened).toBe(1);
    expect(row(summary.queries, 'one').median_rank_opened).toBeNull();
    expect(row(summary.queries, 'other').follow_through_share).toBe(0);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Hook injections are not reads]]
  it('does not count a hook event with a section id as a read or a command', async () => {
    const summary = await (await setup()).aggregator.summary();
    expect(summary.totals.injected_events).toBe(1);
    expect(summary.totals.injected_bytes).toEqual({
      total: 500,
      known: 1,
      unknown: 0,
    });
    expect(row(summary.sections, SEC.one).reads).toBe(1);
    expect(summary.commands.map((c) => c.key)).not.toContain(
      'hook claude PostToolUse',
    );
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Sections and documents count reads]]
  it('builds section and document read rows', async () => {
    const { sections, documents } = await (await setup()).aggregator.summary();
    expect(sections.map((s) => [s.key, s.reads])).toEqual([
      [SEC.two, 2],
      [SEC.one, 1],
      [SEC.three, 1],
    ]);
    const two = row(sections, SEC.two);
    expect(two.document).toBe('docs/a');
    expect(two.reads_by_day).toEqual([
      { day: '2026-11-08', reads: 1 },
      { day: '2026-11-09', reads: 1 },
    ]);
    expect(two.queries).toEqual([{ query: 'foo bar', count: 2 }]);
    expect(two.issues).toEqual(['lat-1', 'lat-1.1', 'lat-2']);
    expect(row(sections, SEC.three).queries).toEqual([]);
    expect(documents.map((d) => [d.key, d.reads, d.sections_read])).toEqual([
      ['docs/a', 3, 2],
      ['docs/b', 1, 1],
    ]);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Unknown is not zero]]
  it('counts null values as unknown and never as zero', async () => {
    const summary = await (await setup()).aggregator.summary();
    expect(summary.totals.tokens.input).toEqual({
      total: 310,
      known: 3,
      unknown: 1,
    });
    expect(summary.totals.tokens.output).toEqual({
      total: 55,
      known: 2,
      unknown: 2,
    });
    expect(summary.totals.tokens.cache_read).toEqual({
      total: null,
      known: 0,
      unknown: 4,
    });
    expect(summary.totals.tokens.reported_cost_usd).toEqual({
      total: null,
      known: 0,
      unknown: 4,
    });
    expect(summary.totals.bytes_out).toEqual({
      total: 1000,
      known: 1,
      unknown: 8,
    });
    expect(row(summary.agents, 'codex').totals.bytes_out.total).toBeNull();
    expect(summary.totals.searches_unknown_results).toBe(1);
    expect(summary.totals.zero_result_searches).toBe(1);
    expect(summary.totals.zero_result_rate).toBe(0.25);
    expect(row(summary.agents, 'pi').totals.bytes_out).toEqual({
      total: 0,
      known: 0,
      unknown: 0,
    });
  });

  it('computes the search, bypass, error and latency metrics', async () => {
    const { totals } = await (await setup()).aggregator.summary();
    expect(totals.searches).toBe(5);
    expect(totals.followed_searches).toBe(2);
    expect(totals.follow_through_rate).toBe(0.4);
    expect(totals.reformulation_rate).toBe(0.2);
    expect(totals.section_reads).toBe(4);
    expect(totals.bypass_reads).toBe(1);
    expect(totals.bypass_rate).toBe(0.2);
    expect(totals.errors).toBe(1);
    expect(totals.latency_ms).toEqual({ p50: 100, p95: 300 });
    expect(totals.median_rank_opened).toBe(1.5);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Daily series and the previous range]]
  it('carries a daily series and the previous range on every row', async () => {
    const { aggregator } = await setup();
    const summary = await aggregator.summary({
      from: '2026-11-09',
      to: '2026-11-09',
    });
    expect(summary.days).toEqual(['2026-11-09']);
    expect(summary.totals.commands).toBe(2);
    expect(summary.previous?.commands).toBe(7);
    expect(summary.range).toEqual({
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z',
      previous_from: '2026-11-08T00:00:00.000Z',
      previous_to: '2026-11-09T00:00:00.000Z',
    });
    const claude = row(summary.agents, 'claude');
    expect(claude.totals.commands).toBe(0);
    expect(claude.previous?.commands).toBe(6);
    expect(claude.daily.map((d) => [d.day, d.commands])).toEqual([
      ['2026-11-09', 0],
    ]);
    const codex = row(summary.agents, 'codex');
    expect(codex.daily.map((d) => [d.day, d.commands])).toEqual([
      ['2026-11-09', 2],
    ]);
    expect(row(summary.sessions, 'B').previous?.commands).toBe(0);
    expect(row(summary.queries, 'foo bar').previous?.commands).toBe(3);
    expect(summary.unattributed.totals.commands).toBe(2);
    expect(summary.unattributed.previous?.commands).toBe(4);

    const twoDays = await aggregator.summary({
      from: '2026-11-08',
      to: '2026-11-09',
    });
    expect(twoDays.days).toEqual(['2026-11-08', '2026-11-09']);
    expect(twoDays.daily.map((d) => d.commands)).toEqual([7, 2]);
    expect(twoDays.previous?.commands).toBe(0);

    const open = await aggregator.summary();
    expect(open.previous).toBeNull();
    expect(row(open.agents, 'claude').previous).toBeNull();
    expect(open.days).toEqual(['2026-11-08', '2026-11-09']);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Totals carry commands per session, search hit rate and follow-through]]
  it('carries commands per session, search hit rate and follow-through on the previous range and each day', async () => {
    const { aggregator } = await setup();
    const summary = await aggregator.summary({
      from: '2026-11-08',
      to: '2026-11-09',
    });
    for (const totals of [
      summary.totals,
      summary.previous!,
      ...summary.daily,
    ]) {
      const answered = totals.searches - totals.searches_unknown_results;
      expect(totals.lat_commands_per_session).toEqual(
        totals.sessions > 0 ? totals.commands / totals.sessions : null,
      );
      expect(totals.search_hit_rate).toEqual(
        answered > 0
          ? (answered - totals.zero_result_searches) / answered
          : null,
      );
      expect(totals.follow_through_rate).toEqual(
        totals.searches > 0 ? totals.followed_searches / totals.searches : null,
      );
    }
    expect(summary.totals.lat_commands_per_session).toBe(
      summary.signals.lat_commands_per_session,
    );
    expect(summary.totals.search_hit_rate).toBe(
      summary.signals.search_hit_rate,
    );
    expect(summary.totals.follow_through_rate).toBe(
      summary.signals.follow_through_rate,
    );
    expect(summary.daily.map((day) => day.lat_commands_per_session)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Each row carries five health signals]]
  it('carries the five health signals on agent, session and issue rows', async () => {
    const summary = await (await setup()).aggregator.summary();
    const claude = row(summary.agents, 'claude').signals;
    expect(claude.lat_commands_per_session).toBe(3);
    expect(claude.search_hit_rate).toBeCloseTo(2 / 3);
    expect(claude.follow_through_rate).toBe(
      row(summary.agents, 'claude').totals.follow_through_rate,
    );
    expect(claude.bypass_rate).toBe(0.25);
    expect(claude.net_tokens_saved).toBeNull();
    expect(claude.injected_bytes).toEqual({ total: 500, known: 1, unknown: 0 });
    const codex = row(summary.agents, 'codex').signals;
    expect(codex.lat_commands_per_session).toBe(2);
    expect(codex.search_hit_rate).toBeNull();
    expect(codex.follow_through_rate).toBe(1);
    expect(codex.bypass_rate).toBe(0);
    expect(row(summary.agents, 'pi').signals.bypass_rate).toBeNull();
    expect(
      row(summary.issues, 'lat-1.1').signals.lat_commands_per_session,
    ).toBe(1.5);
    expect(
      row(summary.issues, 'lat-1.1').rolled_up.signals.net_tokens_saved,
    ).toBeNull();
    expect(summary.unattributed.signals.search_hit_rate).toBeCloseTo(2 / 3);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Filters narrow the summary]]
  it('parses the filter parameters', () => {
    expect(
      parseUsageFilters(
        new URLSearchParams(
          'from=2026-11-08&to=2026-11-09&agent=claude&session=alpha&issue=lat-1',
        ),
      ),
    ).toEqual({
      from: '2026-11-08',
      to: '2026-11-09',
      agent: 'claude',
      session: 'alpha',
      issue: 'lat-1',
    });
    expect(
      parseUsageFilters({ agent: 'codex', issue: ['lat-2', 'x'] }),
    ).toEqual({
      agent: 'codex',
      issue: 'lat-2',
    });
    expect(parseUsageFilters({})).toEqual({});
    expect(parseUsageFilters({ agent: '' })).toEqual({});
    expect(() => parseUsageFilters({ from: 'yesterday' })).toThrow(/from/);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Filters narrow the summary]]
  it('applies the agent, session, issue and date filters', async () => {
    const { aggregator } = await setup();
    expect((await aggregator.summary({ agent: 'codex' })).totals.commands).toBe(
      2,
    );
    expect((await aggregator.summary({ session: 'A' })).totals.commands).toBe(
      5,
    );
    expect(
      (await aggregator.summary({ session: 'alpha2' })).totals.commands,
    ).toBe(5);
    expect(
      (await aggregator.summary({ to: '2026-11-08' })).totals.commands,
    ).toBe(7);

    const epic = await aggregator.summary({ issue: 'lat-1' });
    expect(epic.totals.commands).toBe(3);
    // attribution is computed before filtering: the shared event still counts for lat-2
    expect(row(epic.issues, 'lat-2').totals.commands).toBe(3);
    expect(row(epic.issues, 'lat-1.1').totals.commands).toBe(3);
    expect(
      (await aggregator.summary({ issue: 'lat-1.1' })).totals.commands,
    ).toBe(3);
    expect((await aggregator.summary({ issue: 'nope' })).totals.commands).toBe(
      0,
    );
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Contributions register one line each]]
  it('adds registered contributions under extensions and lets one supply net tokens', async () => {
    const contribution: Contribution = {
      key: 'example',
      compute: async (context) => ({ items: context.items.length }),
      netTokensSaved: () => 42,
    };
    const { aggregator } = await setup({ contributions: [contribution] });
    const summary: UsageSummary = await aggregator.summary();
    expect(summary.extensions.example).toEqual({ items: 15 });
    expect(row(summary.agents, 'claude').signals.net_tokens_saved).toBe(42);
    expect(
      row(summary.issues, 'lat-1').rolled_up.signals.net_tokens_saved,
    ).toBe(42);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A throwing contribution is isolated]]
  it('reports a throwing contribution under its key and keeps the summary', async () => {
    const broken: Contribution = {
      key: 'broken',
      compute: () => {
        throw new Error('boom');
      },
      netTokensSaved: () => {
        throw new Error('no savings');
      },
    };
    const fine: Contribution = { key: 'fine', compute: () => 1 };
    const { aggregator } = await setup({ contributions: [broken, fine] });
    const summary = await aggregator.summary();
    expect(summary.extensions).toEqual({ broken: { error: 'boom' }, fine: 1 });
    expect(summary.totals.commands).toBe(9);
    const signals = row(summary.agents, 'claude').signals;
    expect(signals.net_tokens_saved).toBeNull();
    expect(signals.net_tokens_saved_reason).toBe('no savings');
  });

  // @lat: [[usage-aggregate#Usage Aggregate#Prepare runs before rows are built]]
  it('awaits prepare before netTokensSaved on the first summary', async () => {
    let loaded: number | null = null;
    const lazy: Contribution = {
      key: 'lazy',
      prepare: async () => {
        await Promise.resolve();
        loaded = 7;
      },
      compute: () => loaded,
      netTokensSaved: () => loaded,
    };
    const { aggregator } = await setup({ contributions: [lazy] });
    const summary = await aggregator.summary();
    expect(row(summary.agents, 'claude').signals.net_tokens_saved).toBe(7);
    expect(summary.extensions.lazy).toBe(7);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A throwing prepare is isolated]]
  it('isolates a throwing prepare', async () => {
    const broken: Contribution = {
      key: 'broken',
      prepare: () => {
        throw new Error('no snapshot');
      },
      compute: () => 'unreachable',
      netTokensSaved: () => 99,
    };
    const fine: Contribution = { key: 'fine', compute: () => 1 };
    const { aggregator } = await setup({ contributions: [broken, fine] });
    const summary = await aggregator.summary();
    expect(summary.extensions).toEqual({
      broken: { error: 'no snapshot' },
      fine: 1,
    });
    const signals = row(summary.agents, 'claude').signals;
    expect(signals.net_tokens_saved).toBeNull();
    expect(signals.net_tokens_saved_reason).toBe('no snapshot');
    expect(summary.totals.commands).toBe(9);
  });

  // @lat: [[usage-aggregate#Usage Aggregate#state.json keeps no shell command text]]
  it('stores tool calls in state.json without their shell command', async () => {
    const root = tempRoot();
    const secret = 'cat /private/secret-token-xyz';
    await setup({
      root,
      claudeEvents: [
        session('tool_call', 'A', 1, {
          tool: {
            name: 'Bash',
            action: 'shell',
            path: null,
            bytes: 12,
            shell: { command: secret, exit_code: { value: 3 } },
          },
        }),
      ],
    });
    const text = readFileSync(
      join(root, '.lat', 'usage', 'state.json'),
      'utf-8',
    );
    expect(text).not.toContain(secret);
    const stored = Object.values(
      JSON.parse(text).sessions as Record<string, any>,
    )
      .map((entry) => entry.event)
      .find((event) => event.kind === 'tool_call');
    expect(stored.tool).toEqual({
      name: 'Bash',
      action: 'shell',
      path: null,
      bytes: 12,
      shell: { exit_code: { value: 3 } },
    });
    expect(stored.source.path).toBeTruthy();
  });

  // @lat: [[usage-aggregate#Usage Aggregate#A parent link on any event attributes a subagent]]
  it('attributes a subagent through a parent link carried by a non-bd event', async () => {
    const claude = [
      session('bd_command', 'P', 0, { verb: 'claim', issue_id: 'lat-2' }),
      session('bd_command', 'P', 10, { verb: 'close', issue_id: 'lat-2' }),
      // the only events naming P as the parent of C1 and C2
      session('session_start', 'C1', 1, {}, 'P'),
      session(
        'tool_call',
        'C2',
        1,
        { tool: { name: 'Read', action: 'read', path: 'x.ts', bytes: 1 } },
        'P',
      ),
    ];
    const { aggregator } = await setup({
      usageEvents: [
        usage({
          event_id: 'c1',
          ts: at(2),
          session_id: 'C1',
          parent_session_id: null,
          query: 'one',
        }),
        usage({
          event_id: 'c2',
          ts: at(3),
          session_id: 'C2',
          parent_session_id: null,
          query: 'two',
        }),
      ],
      claudeEvents: claude,
      codexEvents: [],
    });
    const summary = await aggregator.summary();
    expect(row(summary.issues, 'lat-2').totals.commands).toBe(2);
    expect(summary.unattributed.totals.commands).toBe(0);
    expect(row(summary.sessions, 'C1').parent_session_id).toBe('P');
    expect(row(summary.sessions, 'C2').parent_session_id).toBe('P');
  });

  it('attributes nothing when bd is unavailable', async () => {
    const { aggregator } = await setup({ snapshot: null });
    const summary = await aggregator.summary();
    expect(summary.issues).toEqual([]);
    expect(summary.unattributed.totals.commands).toBe(9);
  });
});
