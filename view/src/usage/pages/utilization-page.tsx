import type { MouseEvent, ReactNode } from 'react';
import type { UsageOverview } from '../../../../src/fork/usage/aggregate-types';
import type {
  Finding,
  FindingsResult,
} from '../../../../src/fork/usage/findings';
import type {
  CounterEffort,
  GroupName,
  GroupResult,
  MissConsequences,
  WindowedRate,
} from '../../../../src/fork/usage/miss-consequences';
import type {
  MissedKnowledge,
  Outcome,
  SessionReach,
} from '../../../../src/fork/usage/missed-knowledge';
import type {
  ScorecardRow,
  SectionScorecard,
} from '../../../../src/fork/usage/section-scorecard';
import { BarList } from '../charts/bar-list';
import { StackedBars, type StackSeries } from '../charts/stacked-bars';
import { EntityTable } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';

const WRAP = { overflowWrap: 'anywhere' } as const;
const SCROLL = { overflowX: 'auto', maxWidth: '100%' } as const;
const TOP_FINDINGS = 10;
const FINDING_KINDS = ['uncovered-hot-file', 'search-miss'];

const OUTCOME_SERIES: StackSeries[] = [
  { key: 'reached', label: 'reached', color: 'var(--heat-5)' },
  { key: 'read-late', label: 'read-late', color: 'var(--heat-3)' },
  { key: 'bypassed', label: 'bypassed', color: 'var(--agent-claude)' },
  {
    key: 'found-not-opened',
    label: 'found-not-opened',
    color: 'var(--agent-pi)',
  },
  {
    key: 'searched-not-found',
    label: 'searched-not-found',
    color: 'var(--agent-antigravity)',
  },
  {
    key: 'never-consulted',
    label: 'never-consulted',
    color: 'var(--agent-codex)',
  },
];

const COMPARISON_LABEL = 'correlation, not cause';
const count = (value: number) => value.toLocaleString('en-US');
const percent = (fraction: number) => Math.round(fraction * 100);
const unknownText = (reason: string) => `unknown (${reason})`;

function useFilterSearch(): string {
  const { filters } = useUsageFilters();
  const query = filtersToSearchParams(filters).toString();
  return query ? `?${query}` : '';
}

function Link({ to, children }: { to: string; children: ReactNode }) {
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    event.preventDefault();
    navigateTo(to);
  }
  return (
    <a href={to} onClick={follow} style={WRAP}>
      {children}
    </a>
  );
}

type Extension<T> = { value: T } | { unknown: string };

/** An extension that is missing or holds `{ error }` is unknown with its reason. */
function extensionOf<T>(raw: unknown, name: string): Extension<T> {
  if (raw === undefined || raw === null)
    return { unknown: `the ${name} is missing from the summary` };
  const failure = (raw as { error?: unknown }).error;
  if (typeof failure === 'string') return { unknown: failure };
  return { value: raw as T };
}

const Unknown = ({ reason }: { reason: string }) => (
  <p>{unknownText(reason)}</p>
);

const findingPath = (finding: Finding, search: string) =>
  `/_usage/findings/${encodeURIComponent(finding.id)}${search}`;
const sectionPath = (sectionId: string, search: string) =>
  `/_usage/knowledge/${encodeURIComponent(sectionId)}${search}`;
const sessionPath = (sessionId: string, search: string) =>
  `/_usage/sessions/${encodeURIComponent(sessionId)}${search}`;

function Reach({ data }: { data: MissedKnowledge }) {
  const types = data.by_issue_type;
  if (types.length === 0) return <p>No sessions under the current filters.</p>;
  const unknownTypes = types.filter((t) => t.reach === null);
  return (
    <>
      <BarList
        label="Knowledge reach by issue type"
        limit={types.length}
        items={types.map((t) => ({
          label: t.key,
          value: t.reach === null ? null : percent(t.reach),
        }))}
      />
      <p>Reach is the percent of expected sections that were reached.</p>
      {unknownTypes.length > 0 && (
        <ul aria-label="Issue types with unknown reach">
          {unknownTypes.map((t) => (
            <li key={t.key} style={WRAP}>
              {t.key}: {unknownText(t.reach_reason ?? 'no reason recorded')}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Outcomes({ data }: { data: MissedKnowledge }) {
  return (
    <StackedBars
      label="Miss outcomes by issue type"
      series={OUTCOME_SERIES}
      bars={data.by_issue_type.map((t) => ({
        label: t.key,
        values: t.outcomes as Record<Outcome, number>,
      }))}
    />
  );
}

function FindingList({
  title,
  kind,
  result,
  search,
}: {
  title: string;
  kind: string;
  result: FindingsResult;
  search: string;
}) {
  const shown = result.findings
    .filter((f) => f.kind === kind)
    .sort(
      (a, b) =>
        b.sessions - a.sessions ||
        b.count - a.count ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, TOP_FINDINGS);
  return (
    <>
      <h3>{title}</h3>
      {shown.length === 0 ? (
        <p>None found under the current filters.</p>
      ) : (
        <ol aria-label={title}>
          {shown.map((f) => (
            <li key={f.id} style={WRAP}>
              <Link to={findingPath(f, search)}>{f.subject}</Link> (
              {count(f.count)} in {count(f.sessions)}{' '}
              {f.sessions === 1 ? 'session' : 'sessions'})
              {f.expected_section_id !== undefined && (
                <>
                  {' '}
                  expected{' '}
                  <Link to={sectionPath(f.expected_section_id, search)}>
                    {f.expected_section_id}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Findings({
  findings,
  search,
}: {
  findings: ReturnType<typeof useUsageData<FindingsResult>>;
  search: string;
}) {
  const { data, error, loading } = findings;
  return (
    <>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading findings…</p>}
      {data && data.errors.length > 0 && (
        <p role="note" style={WRAP}>
          Some detectors failed:{' '}
          {data.errors.map((e) => `${e.detector} (${e.message})`).join(', ')}
        </p>
      )}
      {data && (
        <>
          <FindingList
            title="Top undocumented files"
            kind={FINDING_KINDS[0]}
            result={data}
            search={search}
          />
          <FindingList
            title="Top search misses"
            kind={FINDING_KINDS[1]}
            result={data}
            search={search}
          />
        </>
      )}
    </>
  );
}

const missesOf = (row: ScorecardRow) => row.expected - row.reached;

function Scorecard({
  scorecard,
  search,
}: {
  scorecard: SectionScorecard;
  search: string;
}) {
  if (scorecard.sections.length === 0)
    return <p>No section was expected under the current filters.</p>;
  return (
    <EntityTable<ScorecardRow>
      label="Sections to fix first"
      columns={[
        { key: 'section', header: 'Section', value: (r) => r.section_id },
        {
          key: 'misses',
          header: 'Misses',
          value: missesOf,
          numeric: true,
        },
        {
          key: 'expected',
          header: 'Times expected',
          value: (r) => r.expected,
          numeric: true,
        },
        {
          key: 'reach',
          header: 'Reach %',
          value: (r) => (r.reach === null ? null : percent(r.reach)),
          numeric: true,
        },
        {
          key: 'main-miss',
          header: 'Main miss',
          value: (r) => r.main_miss,
          unknownText: 'none',
        },
        {
          key: 'fix',
          header: 'Suggested fix',
          value: (r) => r.suggested_fix,
          unknownText: 'none',
        },
      ]}
      rows={scorecard.sections}
      rowKey={(r) => r.section_id}
      href={(r) => sectionPath(r.section_id, search)}
      trend={{
        header: 'Reach per day',
        points: (r) => r.daily.map((d) => ({ day: d.day, value: d.reach })),
      }}
      defaultSort={{ key: 'misses', direction: 'descending' }}
    />
  );
}

function SessionTable({
  sessions,
  search,
}: {
  sessions: SessionReach[];
  search: string;
}) {
  if (sessions.length === 0)
    return <p>No sessions under the current filters.</p>;
  return (
    <EntityTable<SessionReach>
      label="Sessions"
      columns={[
        { key: 'session', header: 'Session', value: (s) => s.session_id },
        {
          key: 'types',
          header: 'Issue types',
          value: (s) =>
            s.issue_types.length ? s.issue_types.join(', ') : null,
          unknownText: 'untyped',
        },
        {
          key: 'reach',
          header: 'Reach %',
          value: (s) => (s.reach === null ? null : percent(s.reach)),
          numeric: true,
        },
        {
          key: 'misses',
          header: 'Misses',
          value: (s) =>
            s.status === 'measured' ? s.expected_sections - s.reached : null,
          numeric: true,
        },
        {
          key: 'why',
          header: 'Why unknown',
          value: (s) =>
            s.reach === null ? (s.reach_reason ?? s.reason) : null,
          unknownText: 'n/a',
        },
      ]}
      rows={sessions}
      rowKey={(s) => s.session_id}
      href={(s) => sessionPath(s.session_id, search)}
      defaultSort={{ key: 'misses', direction: 'descending' }}
    />
  );
}

const GROUPS: { name: GroupName; title: string }[] = [
  { name: 'reached_everything', title: 'Reached everything' },
  { name: 'had_a_miss', title: 'Had a miss' },
];

const REASON_PHRASES: Record<string, string> = {
  no_eligible_sample: 'no eligible session or issue in the sample',
  session_end_unknown: 'session end time unknown',
  never_closed: 'issue never closed',
  not_in_bd: 'issue not in bd',
  close_time_unknown: 'close time unknown',
  before_journal_retention: 'before the bd journal retention',
};
const reasonPhrase = (code: string) => REASON_PHRASES[code] ?? code;

function leftOutText(rate: WindowedRate): string {
  const parts = [
    ...(rate.left_out_window_not_complete > 0
      ? [`${count(rate.left_out_window_not_complete)} window not complete`]
      : []),
    ...Object.entries(rate.left_out_other).map(
      ([code, n]) => `${count(n)} ${reasonPhrase(code)}`,
    ),
  ];
  return parts.length > 0 ? `; left out: ${parts.join(', ')}` : '';
}

function rateText(rate: WindowedRate): string {
  const left = leftOutText(rate);
  if (rate.rate === null)
    return `${unknownText(reasonPhrase(rate.reason ?? 'no sample'))} (n=${count(rate.sample)}${left})`;
  return `${percent(rate.rate)}% (${count(rate.count)} of ${count(rate.sample)}${left})`;
}

function effortText(effort: CounterEffort): string {
  const unknown =
    (effort.unknown_issues > 0
      ? ` +${count(effort.unknown_issues)} unknown`
      : '') +
    (effort.issues_with_unknown > 0
      ? `; ${count(effort.issues_with_unknown)} partly unknown`
      : '');
  if (effort.median === null)
    return unknownText(reasonPhrase(effort.reason ?? 'no sample')) + unknown;
  return `${count(effort.median)} (n=${count(effort.sample)})${unknown}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${seconds % 60}s`
    : `${hours}h ${minutes % 60}m`;
}

function durationText({ effort }: GroupResult): string {
  const unknown =
    effort.duration_unknown > 0
      ? ` +${count(effort.duration_unknown)} unknown`
      : '';
  if (effort.duration_ms_median === null)
    return `${unknownText(reasonPhrase(effort.duration_reason ?? 'no sample'))} (n=${count(effort.duration_sample)})${unknown}`;
  return `${formatDuration(effort.duration_ms_median)} (n=${count(effort.duration_sample)})${unknown}`;
}

function failedRunsText(group: GroupResult): string {
  const runs = group.failed_test_runs;
  const unknown =
    runs.unknown_sessions > 0
      ? `; ${count(runs.unknown_sessions)} sessions unknown`
      : '';
  if (runs.per_session === null)
    return `${unknownText(reasonPhrase(runs.reason ?? 'no sample'))} (n=${count(runs.sample)}${unknown})`;
  return `${runs.per_session.toLocaleString('en-US')} per session (n=${count(runs.sample)}${unknown})`;
}

function comparisonRows(
  data: MissConsequences,
): { metric: string; cell: (group: GroupResult) => string }[] {
  const counters = Object.keys(data.groups.reached_everything.effort.tokens);
  return [
    { metric: 'Sample', cell: (g) => `n=${count(g.sessions)} sessions` },
    { metric: 'Rework', cell: (g) => rateText(g.rework) },
    { metric: 'Follow-up bugs', cell: (g) => rateText(g.follow_up_bugs) },
    { metric: 'Reopened issues', cell: (g) => rateText(g.reopened_issues) },
    { metric: 'Failed test runs', cell: failedRunsText },
    ...counters.map((counter) => ({
      metric: `Median ${counter} tokens per issue`,
      cell: (g: GroupResult) =>
        effortText(g.effort.tokens[counter as keyof typeof g.effort.tokens]),
    })),
    { metric: 'Median duration per issue', cell: durationText },
  ];
}

function Consequences({ data }: { data: MissConsequences }) {
  return (
    <div role="group" aria-label="Did misses cost anything">
      <p>
        {COMPARISON_LABEL}; method version {data.method_version}.
      </p>
      <div style={SCROLL}>
        <table>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              {GROUPS.map((g) => (
                <th key={g.name} scope="col">
                  {g.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparisonRows(data).map((row) => (
              <tr key={row.metric}>
                <th scope="row">{row.metric}</th>
                {GROUPS.map((g) => (
                  <td key={g.name}>{row.cell(data.groups[g.name])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={WRAP}>{data.reopen_limit.note}</p>
    </div>
  );
}

function Section<T>({
  extension,
  children,
}: {
  extension: Extension<T>;
  children: (value: T) => ReactNode;
}) {
  return 'unknown' in extension ? (
    <Unknown reason={extension.unknown} />
  ) : (
    <>{children(extension.value)}</>
  );
}

export function UtilizationPage(_props: UsagePageProps) {
  const search = useFilterSearch();
  const summary = useUsageData<UsageOverview>('/api/usage');
  const findings = useUsageData<FindingsResult>('/api/usage/findings');
  const { data, error, loading } = summary;
  const missed = extensionOf<MissedKnowledge>(
    data?.extensions?.missed_knowledge,
    'missed knowledge analysis',
  );
  const scorecard = extensionOf<SectionScorecard>(
    data?.extensions?.section_scorecard,
    'section scorecard',
  );
  const consequences = extensionOf<MissConsequences>(
    data?.extensions?.miss_consequences,
    'miss consequences analysis',
  );
  return (
    <section>
      <h1>Utilization</h1>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading utilization…</p>}
      {data && (
        <>
          <Section extension={missed}>
            {(value) => (
              <p style={WRAP}>
                Outcomes are inferred from behaviour, not from intent; method
                version {value.method_version}.
              </p>
            )}
          </Section>
          <h2>Knowledge reach by issue type</h2>
          <Section extension={missed}>{(m) => <Reach data={m} />}</Section>
          <h2>Miss outcomes by issue type</h2>
          <Section extension={missed}>{(m) => <Outcomes data={m} />}</Section>
          <h2>Sections to fix first</h2>
          <Section extension={scorecard}>
            {(s) => <Scorecard scorecard={s} search={search} />}
          </Section>
          <h2>Did misses cost anything</h2>
          <Section extension={consequences}>
            {(c) => <Consequences data={c} />}
          </Section>
          <h2>Sessions</h2>
          <Section extension={missed}>
            {(m) => <SessionTable sessions={m.sessions} search={search} />}
          </Section>
        </>
      )}
      <h2>Findings</h2>
      <Findings findings={findings} search={search} />
    </section>
  );
}
