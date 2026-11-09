// @lat: [[usage-miss-consequences#Usage Miss Consequences]]
import {
  DAY_MS,
  Sum,
  TOKEN_COUNTERS,
  median,
  ratio,
  type AggregateContext,
  type Contribution,
  type CountedSum,
} from './aggregate-types.js';
import type { BdSnapshot } from './bd-attribution.js';
import type { TokenCounter } from './schema.js';
import { commandWords, parseShell } from './sources/shell-parse.js';
import {
  collectCommands,
  collectSessions,
  missedKnowledgeContribution,
  readLineAt,
  type MissedKnowledge,
  type SessionReach,
} from './missed-knowledge.js';

export const MISS_CONSEQUENCES_METHOD_VERSION = 1;
export const COMPARISON_LABEL = 'correlation, not cause';

export const REWORK_WINDOW_DAYS = 3;
export const BUG_AND_REOPEN_WINDOW_DAYS = 14;
export const REOPEN_RETENTION_DAYS = 7;

const TEST_RUNNERS = [
  'pnpm test',
  'pnpm vitest',
  'npx vitest',
  'vitest',
  'npm test',
  'yarn test',
  'jest',
  'pytest',
  'go test',
  'cargo test',
  'bundle exec rspec',
  'rspec',
];

const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh']);
const MAX_UNWRAP_DEPTH = 4;

export function isTestRunCommand(command: string, depth = 0): boolean {
  return parseShell(command).some((segment) => {
    const words = commandWords(segment);
    if (SHELL_WRAPPERS.has(words[0]) && depth < MAX_UNWRAP_DEPTH) {
      const flag = words.findIndex(
        (word, i) => i > 0 && /^-[a-z]*c$/.test(word),
      );
      if (flag !== -1)
        return isTestRunCommand(words.slice(flag + 1).join(' '), depth + 1);
    }
    const rest = words.join(' ');
    return TEST_RUNNERS.some(
      (runner) => rest === runner || rest.startsWith(`${runner} `),
    );
  });
}

export type GroupName = 'reached_everything' | 'had_a_miss';

export interface WindowedRate {
  sample: number;
  count: number;
  rate: number | null;
  reason: string | null;
  left_out_window_not_complete: number;
  left_out_other: Record<string, number>;
}

export interface FailedTestRuns {
  sample: number;
  total: number;
  per_session: number | null;
  sessions_with_a_failure: number;
  share_with_a_failure: number | null;
  reason: string | null;
  unknown_sessions: number;
}

export interface CounterEffort {
  median: number | null;
  sample: number;
  issues_with_unknown: number;
  unknown_issues: number;
  reason: string | null;
}

export interface Effort {
  issues: number;
  tokens: Record<TokenCounter, CounterEffort>;
  duration_ms_median: number | null;
  duration_sample: number;
  duration_unknown: number;
  duration_reason: string | null;
}

export interface GroupResult {
  sessions: number;
  issues: number;
  rework: WindowedRate;
  failed_test_runs: FailedTestRuns;
  follow_up_bugs: WindowedRate;
  reopened_issues: WindowedRate;
  effort: Effort;
}

export interface MissConsequences {
  method_version: number;
  label: string;
  windows: {
    rework_days: number;
    follow_up_bug_days: number;
    reopen_days: number;
  };
  reopen_limit: { retention_days: number; note: string };
  groups: Record<GroupName, GroupResult>;
  sessions_without_expected_sections: number;
  last_event: string | null;
}

export interface SessionSpan {
  session_id: string;
  start: number | null;
  end: number | null;
  edited: Set<string>;
  worktrees: string[];
  top_level: boolean;
}

export interface MissConsequencesInput {
  sessions: Pick<
    SessionReach,
    'session_id' | 'issue_ids' | 'expected_sections' | 'had_a_miss'
  >[];
  spans: SessionSpan[];
  failedTestRuns: Map<string, number | null>;
  sessionTokens: Map<string, Record<TokenCounter, CountedSum>>;
  snapshot: BdSnapshot | null;
  lastEvent: number | null;
  now: number;
  reopenRetentionDays?: number;
}

type GroupedSession = MissConsequencesInput['sessions'][number];

interface IssueView {
  id: string;
  missed: boolean;
  sessionIds: string[];
}

const NO_SAMPLE = 'no_eligible_sample';

const nonZero = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

function windowedRate(
  eligible: boolean[],
  incomplete: number,
  other: Record<string, number> = {},
): WindowedRate {
  const count = eligible.filter(Boolean).length;
  return {
    sample: eligible.length,
    count,
    rate: ratio(count, eligible.length),
    reason: eligible.length === 0 ? NO_SAMPLE : null,
    left_out_window_not_complete: incomplete,
    left_out_other: nonZero(other),
  };
}

function reworkOf(
  group: GroupedSession[],
  spans: Map<string, SessionSpan>,
  input: MissConsequencesInput,
): WindowedRate {
  const eligible: boolean[] = [];
  let incomplete = 0;
  let unknownEnd = 0;
  for (const { session_id } of group) {
    const span = spans.get(session_id);
    if (!span || span.end === null) {
      unknownEnd++;
      continue;
    }
    const end = span.end;
    const limit = end + REWORK_WINDOW_DAYS * DAY_MS;
    if (input.lastEvent === null || limit > input.lastEvent) {
      incomplete++;
      continue;
    }
    eligible.push(
      [...spans.values()].some(
        (later) =>
          later.session_id !== session_id &&
          later.start !== null &&
          later.start >= end &&
          later.start <= limit &&
          [...span.edited].some((file) => later.edited.has(file)),
      ),
    );
  }
  return windowedRate(eligible, incomplete, {
    session_end_unknown: unknownEnd,
  });
}

function failedRunsOf(
  group: GroupedSession[],
  failed: Map<string, number | null>,
): FailedTestRuns {
  let sample = 0;
  let total = 0;
  let withFailure = 0;
  let unknown = 0;
  for (const { session_id } of group) {
    const count = failed.get(session_id) ?? null;
    if (count === null) {
      unknown++;
      continue;
    }
    sample++;
    total += count;
    if (count > 0) withFailure++;
  }
  return {
    sample,
    total,
    per_session: ratio(total, sample),
    sessions_with_a_failure: withFailure,
    share_with_a_failure: ratio(withFailure, sample),
    reason: sample === 0 ? NO_SAMPLE : null,
    unknown_sessions: unknown,
  };
}

function issuesOf(sessions: GroupedSession[]): Map<string, IssueView> {
  const issues = new Map<string, IssueView>();
  for (const session of sessions)
    for (const id of session.issue_ids) {
      const view = issues.get(id) ?? { id, missed: false, sessionIds: [] };
      view.missed = view.missed || session.had_a_miss;
      view.sessionIds.push(session.session_id);
      issues.set(id, view);
    }
  return issues;
}

const timeOf = (iso: string | undefined) => (iso ? Date.parse(iso) : null);

function followUpBugsOf(
  group: IssueView[],
  input: MissConsequencesInput,
): WindowedRate {
  const facts = new Map(input.snapshot?.issues.map((i) => [i.id, i]));
  const links = input.snapshot?.discoveredFrom ?? [];
  const eligible: boolean[] = [];
  let incomplete = 0;
  const other = { never_closed: 0, not_in_bd: 0 };
  for (const { id } of group) {
    const issue = facts.get(id);
    if (!issue) {
      other.not_in_bd++;
      continue;
    }
    const closedAt = timeOf(issue.closed_at);
    if (closedAt === null) {
      other.never_closed++;
      continue;
    }
    const windowEnd = closedAt + BUG_AND_REOPEN_WINDOW_DAYS * DAY_MS;
    if (input.lastEvent === null || windowEnd > input.lastEvent) {
      incomplete++;
      continue;
    }
    eligible.push(
      links.some((link) => {
        const created = Date.parse(link.issueCreatedAt);
        return (
          link.discoveredFromId === id &&
          link.issueType === 'bug' &&
          created > closedAt &&
          created <= windowEnd
        );
      }),
    );
  }
  return windowedRate(eligible, incomplete, other);
}

function reopensOf(
  group: IssueView[],
  input: MissConsequencesInput,
): WindowedRate {
  const retentionDays = input.reopenRetentionDays ?? REOPEN_RETENTION_DAYS;
  const windowMs = Math.min(BUG_AND_REOPEN_WINDOW_DAYS, retentionDays) * DAY_MS;
  const facts = new Map(input.snapshot?.issues.map((i) => [i.id, i]));
  const reopensBy = new Map<string, number[]>();
  for (const reopen of input.snapshot?.reopens ?? [])
    reopensBy.set(reopen.issueId, [
      ...(reopensBy.get(reopen.issueId) ?? []),
      Date.parse(reopen.ts),
    ]);
  const eligible: boolean[] = [];
  let incomplete = 0;
  const other = {
    never_closed: 0,
    not_in_bd: 0,
    close_time_unknown: 0,
    before_journal_retention: 0,
  };
  for (const { id } of group) {
    const issue = facts.get(id);
    if (!issue) {
      other.not_in_bd++;
      continue;
    }
    const reopens = reopensBy.get(id) ?? [];
    const closedAt = timeOf(issue.closed_at);
    if (closedAt === null) {
      if (reopens.length > 0) other.close_time_unknown++;
      else other.never_closed++;
      continue;
    }
    if (reopens.some((ts) => ts < closedAt)) {
      other.close_time_unknown++;
      continue;
    }
    if (closedAt < input.now - retentionDays * DAY_MS) {
      other.before_journal_retention++;
      continue;
    }
    if (input.lastEvent === null || closedAt + windowMs > input.lastEvent) {
      incomplete++;
      continue;
    }
    eligible.push(reopens.some((ts) => ts - closedAt <= windowMs));
  }
  return windowedRate(eligible, incomplete, other);
}

function mergeCounted(parts: CountedSum[]): CountedSum {
  const sum = parts.reduce((total, part) => total + (part.total ?? 0), 0);
  const known = parts.reduce((total, part) => total + part.known, 0);
  const unknown = parts.reduce((total, part) => total + part.unknown, 0);
  return { total: known === 0 && unknown > 0 ? null : sum, known, unknown };
}

function counterEffort(perIssue: CountedSum[]): CounterEffort {
  const totals = perIssue.flatMap((c) => (c.total === null ? [] : [c.total]));
  return {
    median: median(totals),
    sample: totals.length,
    issues_with_unknown: perIssue.filter(
      (c) => c.total !== null && c.unknown > 0,
    ).length,
    unknown_issues: perIssue.filter((c) => c.total === null).length,
    reason: totals.length === 0 ? NO_SAMPLE : null,
  };
}

function effortOf(
  group: IssueView[],
  spans: Map<string, SessionSpan>,
  input: MissConsequencesInput,
): Effort {
  const durations: number[] = [];
  let durationUnknown = 0;
  const perCounter = Object.fromEntries(
    TOKEN_COUNTERS.map((counter) => [counter, [] as CountedSum[]]),
  ) as Record<TokenCounter, CountedSum[]>;
  for (const issue of group) {
    for (const counter of TOKEN_COUNTERS)
      perCounter[counter].push(
        mergeCounted(
          issue.sessionIds.map(
            (id) =>
              input.sessionTokens.get(id)?.[counter] ?? {
                total: null,
                known: 0,
                unknown: 1,
              },
          ),
        ),
      );
    let duration = 0;
    let hasTopLevel = false;
    for (const id of issue.sessionIds) {
      const span = spans.get(id);
      if (!span || span.start === null || span.end === null) {
        duration = -1;
        break;
      }
      if (span.top_level) {
        hasTopLevel = true;
        duration += span.end - span.start;
      }
    }
    if (duration < 0 || !hasTopLevel) durationUnknown++;
    else durations.push(duration);
  }
  return {
    issues: group.length,
    tokens: Object.fromEntries(
      TOKEN_COUNTERS.map((counter) => [
        counter,
        counterEffort(perCounter[counter]),
      ]),
    ) as Record<TokenCounter, CounterEffort>,
    duration_ms_median: median(durations),
    duration_sample: durations.length,
    duration_unknown: durationUnknown,
    duration_reason: durations.length === 0 ? NO_SAMPLE : null,
  };
}

export function buildMissConsequences(
  input: MissConsequencesInput,
): MissConsequences {
  const grouped = input.sessions.filter((s) => s.expected_sections > 0);
  const spans = new Map(input.spans.map((span) => [span.session_id, span]));
  const issues = issuesOf(grouped);
  const groups = {} as Record<GroupName, GroupResult>;
  for (const name of ['reached_everything', 'had_a_miss'] as const) {
    const missed = name === 'had_a_miss';
    const sessions = grouped.filter((s) => s.had_a_miss === missed);
    const issueGroup = [...issues.values()]
      .filter((issue) => issue.missed === missed)
      .sort((a, b) => a.id.localeCompare(b.id));
    groups[name] = {
      sessions: sessions.length,
      issues: issueGroup.length,
      rework: reworkOf(sessions, spans, input),
      failed_test_runs: failedRunsOf(sessions, input.failedTestRuns),
      follow_up_bugs: followUpBugsOf(issueGroup, input),
      reopened_issues: reopensOf(issueGroup, input),
      effort: effortOf(issueGroup, spans, input),
    };
  }
  const retention = input.reopenRetentionDays ?? REOPEN_RETENTION_DAYS;
  return {
    method_version: MISS_CONSEQUENCES_METHOD_VERSION,
    label: COMPARISON_LABEL,
    windows: {
      rework_days: REWORK_WINDOW_DAYS,
      follow_up_bug_days: BUG_AND_REOPEN_WINDOW_DAYS,
      reopen_days: Math.min(BUG_AND_REOPEN_WINDOW_DAYS, retention),
    },
    reopen_limit: {
      retention_days: retention,
      note: `Reopens come from the bd events journal, which keeps ${retention} days and records only this clone. The reopen window is limited to the retention, and issues closed before it are left out.`,
    },
    groups,
    sessions_without_expected_sections: input.sessions.length - grouped.length,
    last_event:
      input.lastEvent === null ? null : new Date(input.lastEvent).toISOString(),
  };
}

async function runsTestsAt(
  path: string,
  offset: number,
): Promise<boolean | null> {
  if (!path.endsWith('.jsonl')) return null;
  const line = await readLineAt(path, offset);
  if (line === null) return null;
  try {
    const commands: string[] = [];
    collectCommands(JSON.parse(line), commands);
    return commands.some(isTestRunCommand);
  } catch {
    return null;
  }
}

const MAX_VERDICTS = 20_000;
const verdicts = new Map<string, boolean>();

export function forgetMissConsequences(): void {
  verdicts.clear();
}

type ShellEvent = AggregateContext['sessionEvents'][number] & {
  kind: 'tool_call';
};

function nonZeroShellCalls(context: AggregateContext): ShellEvent[] {
  return context.sessionEvents.filter((event): event is ShellEvent => {
    if (event.kind !== 'tool_call' || event.tool.action !== 'shell')
      return false;
    const exit = event.tool.shell?.exit_code?.value;
    return exit !== null && exit !== undefined && exit !== 0;
  });
}

const verdictKey = (context: AggregateContext, eventId: string) =>
  `${context.root}\0${eventId}`;

function failedTestRunsBySession(
  context: AggregateContext,
  sessionIds: string[],
): Map<string, number | null> {
  const failed = new Map<string, number | null>(
    sessionIds.map((id) => [id, 0]),
  );
  for (const event of nonZeroShellCalls(context)) {
    if (!failed.has(event.session_id)) continue;
    const verdict = verdicts.get(verdictKey(context, event.event_id));
    const current = failed.get(event.session_id);
    if (verdict === undefined) failed.set(event.session_id, null);
    else if (current !== null && verdict)
      failed.set(event.session_id, (current ?? 0) + 1);
  }
  return failed;
}

export function spansOf(context: AggregateContext): SessionSpan[] {
  const children = new Set<string>();
  for (const event of context.sessionEvents)
    if (event.parent_session_id) children.add(event.session_id);
  for (const item of context.allItems) {
    const parent =
      item.usage?.parent_session_id ?? item.session?.parent_session_id;
    if (item.session_id && parent) children.add(item.session_id);
  }
  return [...collectSessions(context).values()].map((info) => ({
    session_id: info.id,
    start: info.start,
    end: info.end,
    edited: new Set(
      info.events.flatMap((event) =>
        event.kind === 'tool_call' &&
        event.tool.action === 'edit' &&
        event.tool.path !== null &&
        !event.tool.path.startsWith('/')
          ? [event.tool.path.replace(/^\.\//, '')]
          : [],
      ),
    ),
    worktrees: [...info.worktrees],
    top_level: !children.has(info.id),
  }));
}

export function sessionTokensOf(
  context: AggregateContext,
): Map<string, Record<TokenCounter, CountedSum>> {
  const sums = new Map<string, Record<TokenCounter, Sum>>();
  for (const item of context.items) {
    if (item.session?.kind !== 'token_usage' || !item.session_id) continue;
    let own = sums.get(item.session_id);
    if (!own) {
      own = Object.fromEntries(
        TOKEN_COUNTERS.map((counter) => [counter, new Sum()]),
      ) as Record<TokenCounter, Sum>;
      sums.set(item.session_id, own);
    }
    for (const counter of TOKEN_COUNTERS)
      own[counter].add(item.session.usage[counter]);
  }
  return new Map(
    [...sums].map(([id, own]) => [
      id,
      Object.fromEntries(
        TOKEN_COUNTERS.map((counter) => [counter, own[counter].result()]),
      ) as Record<TokenCounter, CountedSum>,
    ]),
  );
}

export function lastEventOf(context: AggregateContext): number | null {
  let last: number | null = null;
  for (const ts of [
    ...context.allItems.map((item) => item.ts),
    ...context.sessionEvents.map((event) => Date.parse(event.ts)),
  ])
    if (!Number.isNaN(ts)) last = last === null ? ts : Math.max(last, ts);
  return last;
}

export const missConsequencesContribution: Contribution = {
  key: 'miss_consequences',
  async prepare(context) {
    await missedKnowledgeContribution.prepare?.(context);
    const missed = (await missedKnowledgeContribution.compute(
      context,
    )) as MissedKnowledge;
    const wanted = new Set(
      missed.sessions
        .filter((s) => s.expected_sections > 0)
        .map((s) => s.session_id),
    );
    for (const event of nonZeroShellCalls(context)) {
      const key = verdictKey(context, event.event_id);
      if (!wanted.has(event.session_id) || verdicts.has(key)) continue;
      const verdict = await runsTestsAt(event.source.path, event.source.offset);
      if (verdict === null) continue;
      if (verdicts.size >= MAX_VERDICTS)
        verdicts.delete(verdicts.keys().next().value!);
      verdicts.set(key, verdict);
    }
  },
  async compute(context): Promise<MissConsequences> {
    const missed = (await missedKnowledgeContribution.compute(
      context,
    )) as MissedKnowledge;
    return buildMissConsequences({
      sessions: missed.sessions,
      spans: spansOf(context),
      failedTestRuns: failedTestRunsBySession(
        context,
        missed.sessions.map((s) => s.session_id),
      ),
      sessionTokens: sessionTokensOf(context),
      snapshot: context.snapshot,
      lastEvent: lastEventOf(context),
      now: context.now,
    });
  },
};
