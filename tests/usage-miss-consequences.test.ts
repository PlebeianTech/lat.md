import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../src/fork/usage/aggregate.js';
import type {
  AggregateContext,
  Contribution,
  CountedSum,
} from '../src/fork/usage/aggregate-types.js';
import type { TokenCounter } from '../src/fork/usage/schema.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import {
  COMPARISON_LABEL,
  buildMissConsequences,
  forgetMissConsequences,
  isTestRunCommand,
  lastEventOf,
  missConsequencesContribution,
  sessionTokensOf,
  spansOf,
  type MissConsequences,
  type MissConsequencesInput,
  type SessionSpan,
} from '../src/fork/usage/miss-consequences.js';
import { missedKnowledgeContribution } from '../src/fork/usage/missed-knowledge.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const day = (n: number) => T0 + n * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

function session(
  id: string,
  options: { issues?: string[]; miss?: boolean; expected?: number } = {},
): MissConsequencesInput['sessions'][number] {
  return {
    session_id: id,
    issue_ids: options.issues ?? [],
    expected_sections: options.expected ?? 2,
    had_a_miss: options.miss ?? false,
  };
}

function span(
  id: string,
  startDay: number,
  endDay: number,
  files: string[] = ['src/a.ts'],
  options: { worktree?: string; top_level?: boolean } = {},
): SessionSpan {
  return {
    session_id: id,
    start: day(startDay),
    end: day(endDay),
    edited: new Set(files),
    worktrees: [options.worktree ?? '/repo'],
    top_level: options.top_level ?? true,
  };
}

function snapshot(parts: Partial<BdSnapshot> = {}): BdSnapshot {
  return { issues: [], discoveredFrom: [], reopens: [], ...parts };
}

function issue(id: string, closedDay: number | null) {
  return {
    id,
    title: id,
    status: closedDay === null ? 'open' : 'closed',
    issue_type: 'task',
    created_at: iso(day(0)),
    ...(closedDay === null ? {} : { closed_at: iso(day(closedDay)) }),
  };
}

function bugFor(parent: string, createdDay: number, type = 'bug') {
  return {
    issueId: `bug-${parent}-${createdDay}`,
    issueType: type,
    issueCreatedAt: iso(day(createdDay)),
    discoveredFromId: parent,
    discoveredFromType: 'task',
    discoveredFromCreatedAt: iso(day(0)),
    linkedAt: iso(day(createdDay)),
  };
}

function tokens(
  input: number | null,
  output: number,
  unknownInput = 1,
): Record<TokenCounter, CountedSum> {
  const counted = (total: number | null, unknown = 0): CountedSum => ({
    total,
    known: total === null ? 0 : 1,
    unknown,
  });
  return {
    input: counted(input, input === null ? unknownInput : 0),
    output: counted(output),
    cache_read: counted(0),
    cache_write: counted(0),
    reasoning: counted(0),
  };
}

function build(parts: Partial<MissConsequencesInput> = {}): MissConsequences {
  return buildMissConsequences({
    sessions: [],
    spans: [],
    failedTestRuns: new Map(),
    sessionTokens: new Map(),
    snapshot: snapshot(),
    lastEvent: day(60),
    now: day(60),
    ...parts,
  });
}

describe('usage miss consequences', () => {
  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Sessions are grouped by whether they reached every expected section]]
  it('groups sessions and excludes those with no expected sections', () => {
    const result = build({
      sessions: [
        session('a'),
        session('b', { miss: true }),
        session('c', { miss: true }),
        session('d', { expected: 0 }),
      ],
      spans: [
        span('a', 0, 1),
        span('b', 0, 1),
        span('c', 0, 1),
        span('d', 0, 1),
      ],
    });
    expect(result.groups.reached_everything.sessions).toBe(1);
    expect(result.groups.had_a_miss.sessions).toBe(2);
    expect(result.sessions_without_expected_sections).toBe(1);
    expect(result.groups.reached_everything.rework.sample).toBe(1);
    expect(result.groups.had_a_miss.rework.sample).toBe(2);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Issues are grouped from their sessions]]
  it('puts an issue in had-a-miss when any session missed', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['x', 'y'] }),
        session('b', { issues: ['x'], miss: true }),
        session('c', { issues: ['z'], expected: 0 }),
      ],
      spans: [span('a', 0, 1), span('b', 0, 1), span('c', 0, 1)],
    });
    expect(result.groups.had_a_miss.issues).toBe(1);
    expect(result.groups.reached_everything.issues).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Rework is a later session editing the same file within 3 days]]
  it('counts rework inside the 3-day window across worktrees only', () => {
    const result = build({
      sessions: [session('in'), session('out'), session('none')],
      spans: [
        span('in', 0, 1, ['src/a.ts'], { worktree: '/repo-wt1' }),
        span('out', 10, 11, ['src/b.ts']),
        span('none', 20, 21, ['src/c.ts']),
        span('later-in', 3, 4, ['src/a.ts'], { worktree: '/repo-wt2' }),
        span('later-out', 15, 16, ['src/b.ts']),
        span('other-file', 22, 23, ['src/z.ts']),
      ],
    });
    const rework = result.groups.reached_everything.rework;
    expect(rework.sample).toBe(3);
    expect(rework.count).toBe(1);
    expect(rework.rate).toBeCloseTo(1 / 3);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Rework is a later session editing the same file within 3 days]]
  it('does not count an earlier session or the session itself as rework', () => {
    const result = build({
      sessions: [session('a')],
      spans: [
        span('a', 5, 6, ['src/a.ts']),
        span('before', 0, 1, ['src/a.ts']),
      ],
    });
    expect(result.groups.reached_everything.rework.count).toBe(0);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A session too recent for its window is left out and counted]]
  it('leaves out a session whose rework window is not complete', () => {
    const result = build({
      sessions: [session('old'), session('recent')],
      spans: [span('old', 0, 1), span('recent', 58, 59)],
      lastEvent: day(60),
    });
    const rework = result.groups.reached_everything.rework;
    expect(rework.sample).toBe(1);
    expect(rework.left_out_window_not_complete).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A session too recent for its window is left out and counted]]
  it('reports null with a reason when every issue is too recent', () => {
    const result = build({
      sessions: [session('a', { issues: ['x'] })],
      spans: [span('a', 0, 1)],
      snapshot: snapshot({ issues: [issue('x', 55)] }),
    });
    const bugs = result.groups.reached_everything.follow_up_bugs;
    expect(bugs.sample).toBe(0);
    expect(bugs.rate).toBeNull();
    expect(bugs.reason).toBe('no_eligible_sample');
    expect(bugs.left_out_window_not_complete).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A follow-up bug is a bug discovered from the issue within 14 days after close]]
  it('counts a bug created inside 14 days of the close and no other', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['inside'], miss: true }),
        session('b', { issues: ['outside'], miss: true }),
        session('c', { issues: ['before'], miss: true }),
        session('d', { issues: ['feature'], miss: true }),
        session('e', { issues: ['never'], miss: true }),
      ],
      spans: ['a', 'b', 'c', 'd', 'e'].map((id) => span(id, 0, 1)),
      snapshot: snapshot({
        issues: [
          issue('inside', 10),
          issue('outside', 10),
          issue('before', 10),
          issue('feature', 10),
          issue('never', null),
        ],
        discoveredFrom: [
          bugFor('inside', 20),
          bugFor('outside', 25),
          bugFor('before', 9),
          bugFor('feature', 15, 'feature'),
        ],
      }),
    });
    const bugs = result.groups.had_a_miss.follow_up_bugs;
    expect(bugs.sample).toBe(4);
    expect(bugs.count).toBe(1);
    expect(bugs.rate).toBe(0.25);
    expect(bugs.left_out_other).toEqual({ never_closed: 1 });
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A reopen counts inside the window and the journal retention]]
  it('counts a reopen within 14 days and not on day 15', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['soon'] }),
        session('b', { issues: ['late'] }),
        session('c', { issues: ['never'] }),
        session('d', { issues: ['untouched'] }),
      ],
      spans: ['a', 'b', 'c', 'd'].map((id) => span(id, 0, 1)),
      snapshot: snapshot({
        issues: [
          issue('soon', 10),
          issue('late', 10),
          issue('never', null),
          issue('untouched', 10),
        ],
        reopens: [
          { issueId: 'soon', ts: iso(day(24)), seq: 1 },
          { issueId: 'late', ts: iso(day(25)), seq: 2 },
        ],
      }),
      reopenRetentionDays: 60,
    });
    const reopens = result.groups.reached_everything.reopened_issues;
    expect(reopens.sample).toBe(3);
    expect(reopens.count).toBe(1);
    expect(reopens.left_out_other).toEqual({ never_closed: 1 });
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A reopen counts inside the window and the journal retention]]
  it('leaves out a reopened issue whose close time is unknown', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['cleared'] }),
        session('b', { issues: ['reclosed'] }),
      ],
      spans: [span('a', 0, 1), span('b', 0, 1)],
      snapshot: snapshot({
        issues: [issue('cleared', null), issue('reclosed', 30)],
        reopens: [
          { issueId: 'cleared', ts: iso(day(20)), seq: 1 },
          { issueId: 'reclosed', ts: iso(day(20)), seq: 2 },
        ],
      }),
      reopenRetentionDays: 60,
    });
    const reopens = result.groups.reached_everything.reopened_issues;
    expect(reopens.sample).toBe(0);
    expect(reopens.rate).toBeNull();
    expect(reopens.left_out_other).toEqual({ close_time_unknown: 2 });
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A reopen counts inside the window and the journal retention]]
  it('limits the reopen measure to the journal retention and reports it', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['old'] }),
        session('b', { issues: ['kept'] }),
        session('c', { issues: ['old-reopened'] }),
        session('d', { issues: ['recent'] }),
      ],
      spans: ['a', 'b', 'c', 'd'].map((id) => span(id, 0, 1)),
      snapshot: snapshot({
        issues: [
          issue('old', 30),
          issue('kept', 63),
          issue('old-reopened', 30),
          issue('recent', 68),
        ],
        reopens: [{ issueId: 'old-reopened', ts: iso(day(35)), seq: 1 }],
      }),
      lastEvent: day(70),
      now: day(70),
    });
    const reopens = result.groups.reached_everything.reopened_issues;
    expect(result.reopen_limit.retention_days).toBe(7);
    expect(result.reopen_limit.note).toContain('7 days');
    expect(result.windows.reopen_days).toBe(7);
    expect(reopens.left_out_other).toEqual({ before_journal_retention: 2 });
    expect(reopens.left_out_window_not_complete).toBe(1);
    expect(reopens.sample).toBe(1);
    expect(reopens.count).toBe(0);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A reopen counts inside the window and the journal retention]]
  it('uses the retention-limited window to count a reopen', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['inside'] }),
        session('b', { issues: ['outside'] }),
      ],
      spans: [span('a', 0, 1), span('b', 0, 1)],
      snapshot: snapshot({
        issues: [issue('inside', 68), issue('outside', 68)],
        reopens: [{ issueId: 'inside', ts: iso(day(71)), seq: 1 }],
      }),
      lastEvent: day(75),
      now: day(75),
    });
    const reopens = result.groups.reached_everything.reopened_issues;
    expect(reopens.sample).toBe(2);
    expect(reopens.count).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Failed test runs count only listed runners with a non-zero exit]]
  it('reports failed test runs per group with the unknown sessions', () => {
    const result = build({
      sessions: [
        session('a', { miss: true }),
        session('b', { miss: true }),
        session('c', { miss: true }),
      ],
      spans: ['a', 'b', 'c'].map((id) => span(id, 0, 1)),
      failedTestRuns: new Map([
        ['a', 3],
        ['b', 0],
        ['c', null],
      ]),
    });
    const failed = result.groups.had_a_miss.failed_test_runs;
    expect(failed.sample).toBe(2);
    expect(failed.total).toBe(3);
    expect(failed.per_session).toBe(1.5);
    expect(failed.share_with_a_failure).toBe(0.5);
    expect(failed.unknown_sessions).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Test runner matching splits compound commands]]
  it('matches the listed runners after splitting and dropping assignments', () => {
    for (const command of [
      'pnpm test',
      'pnpm vitest run x',
      'NODE_OPTIONS=x pnpm vitest',
      'cd a && pnpm test',
      'make; cargo test --all',
      'false || pytest -x',
      'ls | jest',
      'A=1 B=2 bundle exec rspec spec',
      'npx vitest',
      'yarn test',
      'go test ./...',
      'npm test',
      'rspec',
      'vitest',
      'bash -lc "pnpm test"',
      'bash -lc pnpm test',
      "sh -c 'NODE_OPTIONS=x pnpm vitest'",
      'bash -lc "cd a && cargo test"',
    ])
      expect(isTestRunCommand(command), command).toBe(true);
    for (const command of [
      'echo pnpm test',
      'bash -lc "echo pnpm test"',
      'git commit -m "wip; pnpm test"',
      'pnpm testing',
      'pnpm build',
      'cat jest.config.js',
      'git commit -m "pnpm test"',
      '',
    ])
      expect(isTestRunCommand(command), command).toBe(false);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Effort is tokens and duration per issue]]
  it('reports each token counter separately with unknowns counted', () => {
    const result = build({
      sessions: [
        session('a', { issues: ['x'] }),
        session('b', { issues: ['y'] }),
        session('c', { issues: ['z'] }),
      ],
      spans: [span('a', 0, 1), span('b', 0, 3), span('c', 0, 1)],
      sessionTokens: new Map([
        [
          'a',
          { ...tokens(100, 10), input: { total: 100, known: 1, unknown: 1 } },
        ],
        ['b', tokens(300, 30)],
        ['c', tokens(null, 50, 2)],
      ]),
    });
    const effort = result.groups.reached_everything.effort;
    expect(effort.issues).toBe(3);
    expect(effort.tokens.input).toMatchObject({
      median: 200,
      sample: 2,
      unknown_issues: 1,
      issues_with_unknown: 1,
    });
    expect(effort.tokens.output.median).toBe(30);
    expect(effort.tokens.output.issues_with_unknown).toBe(0);
    expect(effort.duration_ms_median).toBe(DAY);
    expect(effort.duration_sample).toBe(3);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Effort is tokens and duration per issue]]
  it('reports unknown duration for an issue with only subagent sessions', () => {
    const result = build({
      sessions: [session('child', { issues: ['x'] })],
      spans: [span('child', 0, 1, ['src/q.ts'], { top_level: false })],
    });
    const effort = result.groups.reached_everything.effort;
    expect(effort.duration_unknown).toBe(1);
    expect(effort.duration_sample).toBe(0);
    expect(effort.duration_ms_median).toBeNull();
    expect(effort.duration_reason).toBe('no_eligible_sample');
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Effort is tokens and duration per issue]]
  it('skips subagent sessions in duration and reports a session with no span', () => {
    const result = build({
      sessions: [
        session('parent', { issues: ['x'] }),
        session('child', { issues: ['x'] }),
        session('lost', { issues: ['y'] }),
      ],
      spans: [
        span('parent', 0, 2),
        span('child', 0, 1, ['src/q.ts'], { top_level: false }),
      ],
    });
    const effort = result.groups.reached_everything.effort;
    expect(effort.duration_ms_median).toBe(2 * DAY);
    expect(effort.duration_sample).toBe(1);
    expect(effort.duration_unknown).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#The result is labelled a correlation and reports every sample size]]
  it('labels the comparison and reports null for an empty group', () => {
    const result = build();
    expect(result.label).toBe('correlation, not cause');
    expect(COMPARISON_LABEL).toBe(result.label);
    expect(result.method_version).toBe(1);
    const group = result.groups.had_a_miss;
    expect(group.sessions).toBe(0);
    expect(group.rework.rate).toBeNull();
    expect(group.rework.reason).toBe('no_eligible_sample');
    expect(group.failed_test_runs.per_session).toBeNull();
    expect(group.effort.tokens.input.median).toBeNull();
    expect(group.effort.tokens.input.reason).toBe('no_eligible_sample');
  });
});

describe('usage miss consequences through the contribution', () => {
  let dir: string;

  const sessionRow = (id: string, issues: string[] = []) =>
    ({
      session_id: id,
      issue_ids: issues,
      expected_sections: 1,
      had_a_miss: true,
    }) as never;

  function transcript(lines: unknown[]): { path: string; offsets: number[] } {
    const path = join(dir, 'session.jsonl');
    const offsets: number[] = [];
    let text = '';
    for (const line of lines) {
      offsets.push(Buffer.byteLength(text));
      text += `${JSON.stringify(line)}\n`;
    }
    writeFileSync(path, text);
    return { path, offsets };
  }

  function shellEvent(
    id: string,
    sessionId: string,
    path: string,
    offset: number,
    exit: number | null,
  ) {
    return {
      kind: 'tool_call',
      event_id: id,
      session_id: sessionId,
      ts: iso(day(1)),
      source: { path, offset },
      tool: {
        name: 'Bash',
        action: 'shell',
        path: null,
        bytes: null,
        shell: {
          exit_code:
            exit === null
              ? { value: null, reason: 'not_captured' }
              : { value: exit },
        },
      },
    };
  }

  function context(
    sessionEvents: unknown[],
    items: unknown[] = [],
  ): AggregateContext {
    return {
      root: dir,
      filters: {},
      days: [],
      now: day(60),
      items,
      previousItems: null,
      allItems: items,
      sessionEvents,
      snapshot: snapshot(),
      attribution: {
        attributions: new Map(),
        issues: new Map(),
        rollup: new Map(),
      },
      rolledIssues: new Map(),
    } as unknown as AggregateContext;
  }

  async function run(
    events: unknown[],
    items: unknown[] = [],
  ): Promise<MissConsequences> {
    const ctx = context(events, items);
    await missConsequencesContribution.prepare?.(ctx);
    return (await missConsequencesContribution.compute(
      ctx,
    )) as MissConsequences;
  }

  beforeEach(() => {
    forgetMissConsequences();
    dir = mkdtempSync(join(tmpdir(), 'lat-usage-miss-'));
    vi.spyOn(
      missedKnowledgeContribution as Required<Contribution>,
      'prepare',
    ).mockResolvedValue();
    vi.spyOn(missedKnowledgeContribution, 'compute').mockReturnValue({
      sessions: [sessionRow('s1'), sessionRow('s2'), sessionRow('s3')],
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#The command is re-read through the source pointer and never stored]]
  it('re-reads only non-zero shell calls and counts listed runners', async () => {
    const call = (command: string) => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', input: { command } }] },
    });
    const { path, offsets } = transcript([
      call('pnpm test'),
      call('echo pnpm test'),
      call('NODE_OPTIONS=x pnpm vitest'),
      call('pnpm test'),
    ]);
    const result = await run([
      shellEvent('e1', 's1', path, offsets[0], 1),
      shellEvent('e2', 's1', path, offsets[1], 2),
      shellEvent('e3', 's2', path, offsets[2], 1),
      shellEvent('e4', 's3', path, offsets[3], 0),
    ]);
    const failed = result.groups.had_a_miss.failed_test_runs;
    expect(failed.sample).toBe(3);
    expect(failed.total).toBe(2);
    expect(failed.sessions_with_a_failure).toBe(2);
    expect(JSON.stringify(result)).not.toContain('vitest');
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Failed test runs count only listed runners with a non-zero exit]]
  it('does not count a null exit code', async () => {
    const { path, offsets } = transcript([
      { message: { content: [{ input: { command: 'pnpm test' } }] } },
    ]);
    const result = await run([shellEvent('e1', 's1', path, offsets[0], null)]);
    expect(result.groups.had_a_miss.failed_test_runs.total).toBe(0);
    expect(result.groups.had_a_miss.failed_test_runs.unknown_sessions).toBe(0);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Test runner matching splits compound commands]]
  it('counts a Codex-style wrapped command and argv array', async () => {
    const { path, offsets } = transcript([
      {
        payload: {
          name: 'shell',
          arguments: '{"command":["bash","-lc","pnpm test"]}',
        },
      },
      { payload: { cmd: 'bash -lc "NODE_OPTIONS=x pnpm vitest"' } },
      { payload: { cmd: 'bash -lc "echo pnpm test"' } },
    ]);
    const result = await run([
      shellEvent('e1', 's1', path, offsets[0], 1),
      shellEvent('e2', 's2', path, offsets[1], 1),
      shellEvent('e3', 's3', path, offsets[2], 1),
    ]);
    expect(result.groups.had_a_miss.failed_test_runs.total).toBe(2);
  });

  const editEvent = (
    id: string,
    sessionId: string,
    minutes: number,
    path: string,
    extra: Record<string, unknown> = {},
  ) => ({
    kind: 'tool_call',
    event_id: id,
    session_id: sessionId,
    ts: iso(day(minutes)),
    source: { path: '/x.jsonl', offset: 0 },
    tool: { name: 'Edit', action: 'edit', path, bytes: null },
    ...extra,
  });

  const lifecycle = (kind: string, sessionId: string, at: number) => ({
    kind,
    event_id: `${kind}-${sessionId}`,
    session_id: sessionId,
    ts: iso(day(at)),
    source: { path: '/x.jsonl', offset: 0 },
  });

  const usageItem = (
    id: string,
    sessionId: string,
    at: number,
    worktree: string,
  ) => ({
    id,
    ts: day(at),
    day: '',
    session_id: sessionId,
    agent: 'claude',
    usage: { worktree, parent_session_id: null },
    session: null,
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Rework is a later session editing the same file within 3 days]]
  it('counts rework between two worktrees and ignores absolute paths', async () => {
    const events = [
      lifecycle('session_start', 's1', 0),
      editEvent('a1', 's1', 0.5, './src/a.ts'),
      editEvent('a2', 's1', 0.6, '/outside/shared.ts'),
      lifecycle('session_end', 's1', 1),
      lifecycle('session_start', 's2', 2),
      editEvent('b1', 's2', 2.5, 'src/a.ts'),
      editEvent('b2', 's2', 2.6, '/outside/shared.ts'),
      lifecycle('session_end', 's2', 3),
      lifecycle('session_start', 's3', 2),
      editEvent('c1', 's3', 2.5, '/outside/shared.ts'),
      lifecycle('session_end', 's3', 3),
      lifecycle('session_end', 'late', 40),
    ];
    const items = [
      usageItem('u1', 's1', 0.5, '/repo'),
      usageItem('u2', 's2', 2.5, '/repo-wt'),
    ];
    const ctx = context(events, items);
    const spans = new Map(spansOf(ctx).map((span) => [span.session_id, span]));
    expect(spans.get('s1')!.worktrees).toEqual(['/repo']);
    expect(spans.get('s2')!.worktrees).toEqual(['/repo-wt']);
    expect([...spans.get('s1')!.edited]).toEqual(['src/a.ts']);
    expect(spans.get('s1')!.start).toBe(day(0));
    expect(spans.get('s1')!.end).toBe(day(1));
    const result = await run(events, items);
    const rework = result.groups.had_a_miss.rework;
    expect(rework.sample).toBe(3);
    expect(rework.count).toBe(1);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Effort is tokens and duration per issue]]
  it('sums each token counter per session with unknowns counted', () => {
    const tokenItem = (id: string, input: number | null, output: number) => ({
      id,
      ts: day(1),
      day: '',
      session_id: 's1',
      agent: 'claude',
      usage: null,
      session: {
        kind: 'token_usage',
        usage: {
          input,
          output,
          cache_read: null,
          cache_write: null,
          reasoning: null,
        },
      },
    });
    const ctx = context(
      [],
      [
        tokenItem('t1', 10, 1),
        tokenItem('t2', null, 2),
        usageItem('u', 's1', 1, '/r'),
      ],
    );
    const sums = sessionTokensOf(ctx).get('s1')!;
    expect(sums.input).toEqual({ total: 10, known: 1, unknown: 1 });
    expect(sums.output).toEqual({ total: 3, known: 2, unknown: 0 });
    expect(sums.cache_read).toEqual({ total: null, known: 0, unknown: 2 });
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A session too recent for its window is left out and counted]]
  it('takes the last event from items and session events', async () => {
    const events = [lifecycle('session_end', 's1', 5)];
    expect(lastEventOf(context(events))).toBe(day(5));
    expect(lastEventOf(context(events, [usageItem('u', 's1', 6, '/r')]))).toBe(
      day(6),
    );
    expect(lastEventOf(context([]))).toBeNull();
    const result = await run(events, [usageItem('u', 's1', 6, '/r')]);
    expect(result.last_event).toBe(iso(day(6)));
    expect(result.groups.had_a_miss.rework.left_out_window_not_complete).toBe(
      1,
    );
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#Effort is tokens and duration per issue]]
  it('leaves a subagent session out of the duration', () => {
    const events = [
      lifecycle('session_start', 'child', 0),
      { ...lifecycle('session_end', 'child', 1), parent_session_id: 'parent' },
      lifecycle('session_start', 'parent', 0),
    ];
    const spans = new Map(
      spansOf(context(events)).map((span) => [span.session_id, span]),
    );
    expect(spans.get('child')!.top_level).toBe(false);
    expect(spans.get('parent')!.top_level).toBe(true);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#The command is re-read through the source pointer and never stored]]
  it('makes a session unknown when its source cannot be read', async () => {
    const result = await run([
      shellEvent('e1', 's1', join(dir, 'missing.jsonl'), 0, 1),
    ]);
    const failed = result.groups.had_a_miss.failed_test_runs;
    expect(failed.unknown_sessions).toBe(1);
    expect(failed.sample).toBe(2);
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A failing missed-knowledge analysis is an error, not zeros]]
  it('throws when the missed-knowledge compute throws', async () => {
    vi.spyOn(missedKnowledgeContribution, 'compute').mockImplementation(() => {
      throw new Error('analysis broke');
    });
    await expect(run([])).rejects.toThrow('analysis broke');
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#A failing missed-knowledge analysis is an error, not zeros]]
  it('throws when the missed-knowledge prepare throws', async () => {
    vi.spyOn(
      missedKnowledgeContribution as Required<Contribution>,
      'prepare',
    ).mockRejectedValue(new Error('prepare broke'));
    await expect(run([])).rejects.toThrow('prepare broke');
  });

  // @lat: [[usage-miss-consequences#Usage Miss Consequences#The result is labelled a correlation and reports every sample size]]
  it('is registered under miss_consequences', () => {
    expect(missConsequencesContribution.key).toBe('miss_consequences');
    expect(contributions).toContain(missConsequencesContribution);
  });
});
