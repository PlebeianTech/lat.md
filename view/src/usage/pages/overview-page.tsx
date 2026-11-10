import type { MouseEvent, ReactElement, ReactNode } from 'react';
import type {
  DailyPoint,
  Totals,
  UsageOverview,
} from '../../../../src/fork/usage/aggregate-types';
import type {
  Finding,
  FindingsResult,
} from '../../../../src/fork/usage/findings';
import type { MissedKnowledge } from '../../../../src/fork/usage/missed-knowledge';
import type { SavingsEstimate } from '../../../../src/fork/usage/savings';
import { RangeBar } from '../charts/range-bar';
import { Sparkline, type SparklinePoint } from '../charts/sparkline';
import { StackedBars } from '../charts/stacked-bars';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';

const TOP_FINDINGS = 5;
const SERIES_COLORS = [
  'var(--heat-5)',
  'var(--heat-3)',
  'var(--agent-codex)',
  'var(--agent-pi)',
  'var(--agent-antigravity)',
  'var(--agent-claude)',
  'var(--agent-opencode)',
];
const CORRELATION_LABEL = 'correlation, not cause';

type Reach<T> = T | { error: string } | undefined;

function failure(extension: Reach<object>): string | null {
  return extension !== undefined && 'error' in extension
    ? String(extension.error)
    : null;
}

const round = (value: number, places = 1) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const showNumber = (value: number) => round(value).toLocaleString('en-US');
const showPercent = (value: number) => `${round(value * 100)}%`;

function change(
  current: number | null,
  previous: number | null | undefined,
  kind: 'percent' | 'number',
  noPreviousReason: string,
): string {
  if (previous === undefined) return `Change: unknown (${noPreviousReason})`;
  if (current === null) return 'Change: unknown (no value for this range)';
  if (previous === null)
    return 'Change: unknown (no value in the previous range)';
  const delta =
    kind === 'percent'
      ? round((current - previous) * 100)
      : round(current - previous);
  if (delta === 0) return 'Change: none against the previous range';
  const sign = delta > 0 ? '+' : '-';
  const size =
    kind === 'percent'
      ? `${Math.abs(delta)} points`
      : showNumber(Math.abs(delta));
  return `Change: ${sign}${size} against the previous range`;
}

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
    <a href={to} onClick={follow}>
      {children}
    </a>
  );
}

const PANEL = {
  background: 'var(--panel)',
  border: '1px solid var(--panel-border)',
  borderRadius: 8,
  padding: 12,
  minWidth: 0,
};

function Tile({
  name,
  to,
  value,
  changeText,
  points,
  note,
}: {
  name: string;
  to: string;
  value: string;
  changeText: string;
  points: SparklinePoint[];
  note?: string;
}) {
  return (
    <article aria-label={name} style={PANEL}>
      <h3 style={{ margin: 0, fontSize: 14 }}>
        <Link to={to}>{name}</Link>
      </h3>
      <p style={{ margin: '4px 0', fontSize: 24, overflowWrap: 'anywhere' }}>
        {value}
      </p>
      <p style={{ margin: '0 0 4px', color: 'var(--muted)' }}>{changeText}</p>
      {note && (
        <p style={{ margin: '0 0 4px', color: 'var(--muted)' }}>{note}</p>
      )}
      <Sparkline label={`${name} per day`} points={points} />
    </article>
  );
}

const dailyPoints = (
  daily: DailyPoint[],
  of: (point: DailyPoint) => number | null,
): SparklinePoint[] =>
  daily.map((point) => ({ day: point.day, value: of(point) }));

function SignalTiles({
  summary,
  search,
}: {
  summary: UsageOverview;
  search: string;
}) {
  const { totals, previous, daily, signals } = summary;
  const noPrevious = 'no previous range';
  const missed = summary.extensions.missed_knowledge as Reach<MissedKnowledge>;
  const missedError = failure(missed);
  const knowledge = missed && !missedError ? (missed as MissedKnowledge) : null;
  const reach = knowledge?.totals.reach ?? null;
  const reachReason = missedError
    ? missedError
    : missed === undefined
      ? 'knowledge reach not reported'
      : (knowledge?.totals.reach_reason ?? 'no reason given');
  const noReason = 'no reason given';
  return (
    <>
      <Tile
        name="Adoption"
        to={`/_usage/sessions${search}`}
        value={
          signals.lat_commands_per_session === null
            ? 'unknown (no sessions in this range)'
            : `${showNumber(signals.lat_commands_per_session)} commands per session`
        }
        changeText={change(
          signals.lat_commands_per_session,
          previous?.lat_commands_per_session,
          'number',
          noPrevious,
        )}
        points={dailyPoints(daily, (point) => point.lat_commands_per_session)}
      />
      <Tile
        name="Search success"
        to={`/_usage/queries${search}`}
        value={
          signals.follow_through_rate === null
            ? 'unknown (no searches in this range)'
            : showPercent(signals.follow_through_rate)
        }
        changeText={change(
          signals.follow_through_rate,
          previous?.follow_through_rate,
          'percent',
          noPrevious,
        )}
        points={dailyPoints(daily, (point) => point.follow_through_rate)}
        note="Share of searches followed by a section read."
      />
      <Tile
        name="Bypass rate"
        to={`/_usage/findings${search}`}
        value={
          signals.bypass_rate === null
            ? 'unknown (no section or file reads)'
            : showPercent(signals.bypass_rate)
        }
        changeText={change(
          signals.bypass_rate,
          previous ? previous.bypass_rate : undefined,
          'percent',
          noPrevious,
        )}
        points={dailyPoints(daily, (point) => point.bypass_rate)}
      />
      <Tile
        name="Knowledge reach"
        to={`/_usage/knowledge${search}`}
        value={
          reach === null
            ? `unknown (${reachReason || noReason})`
            : showPercent(reach)
        }
        changeText={change(
          reach,
          knowledge && knowledge.previous
            ? knowledge.previous.reach
            : undefined,
          'percent',
          knowledge ? noPrevious : 'knowledge reach not available',
        )}
        points={
          knowledge
            ? knowledge.daily.map((point) => ({
                day: point.day,
                value: point.reach,
              }))
            : []
        }
        note="Share of sections covering edited files that the agent read before editing."
      />
    </>
  );
}

function NetTokensSaved({ summary }: { summary: UsageOverview }) {
  const { signals } = summary;
  const extension = summary.extensions.savings as Reach<SavingsEstimate>;
  const error = failure(extension);
  const savings = extension && !error ? (extension as SavingsEstimate) : null;
  const range = savings?.net_tokens_saved ?? null;
  const unknownReason =
    error ??
    (extension === undefined
      ? (signals.net_tokens_saved_reason ?? 'savings not reported')
      : (savings?.reason ??
        signals.net_tokens_saved_reason ??
        'no reason given'));
  const injectedBytes = savings?.injected_bytes.total ?? null;
  const cost =
    savings && injectedBytes !== null
      ? Math.round(injectedBytes / savings.bytes_per_token.point)
      : null;
  const unknownInjected = savings?.injected_bytes.unknown ?? 0;
  const unknownReads = savings?.saved_bytes.unknown ?? 0;
  const costText =
    cost === null
      ? 'unknown'
      : `${showNumber(cost)} tokens${unknownInjected > 0 ? ` (+${unknownInjected.toLocaleString('en-US')} unknown)` : ''}`;
  return (
    <article
      aria-label="Net tokens saved"
      style={{ ...PANEL, gridColumn: '1 / -1' }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>Net tokens saved</h3>
      <p style={{ margin: '4px 0', fontSize: 28, overflowWrap: 'anywhere' }}>
        {range
          ? `${showNumber(range.point)} (${showNumber(range.low)} to ${showNumber(range.high)})${unknownReads > 0 ? ` (+${showNumber(unknownReads)} reads unknown)` : ''}`
          : `unknown (${unknownReason})`}
      </p>
      <p style={{ margin: '0 0 4px', color: 'var(--muted)' }}>
        Estimate, {CORRELATION_LABEL}
        {savings ? `. Method version ${savings.method_version}.` : '.'} Change:
        unknown (no previous-range estimate).
      </p>
      <p data-field="injected-cost" style={{ margin: '0 0 4px' }}>
        Injected cost: {costText}
      </p>
      <RangeBar
        label="Net tokens saved range"
        range={range}
        cost={cost}
        rangeReason={unknownReason}
        rangeLabel="Net tokens saved"
        costLabel={
          unknownInjected > 0 ? 'Injected cost (known part)' : 'Injected cost'
        }
      />
    </article>
  );
}

function CommandsPerDay({ summary }: { summary: UsageOverview }) {
  const series = summary.commands.map((row, index) => ({
    key: row.key,
    label: row.label,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  }));
  const bars = summary.days.map((day) => ({
    label: day,
    values: Object.fromEntries(
      summary.commands.map((row) => [
        row.key,
        row.daily.find((point) => point.day === day)?.commands ?? null,
      ]),
    ),
  }));
  return (
    <section style={PANEL}>
      <h2 style={{ marginTop: 0 }}>Commands per day</h2>
      <StackedBars label="Commands per day" bars={bars} series={series} />
    </section>
  );
}

function TopFindings({ search }: { search: string }) {
  const { data, error, loading } = useUsageData<FindingsResult>(
    '/api/usage/findings',
  );
  const top: Finding[] = data
    ? [...data.findings]
        .sort(
          (a, b) =>
            b.sessions - a.sessions ||
            b.count - a.count ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, TOP_FINDINGS)
    : [];
  return (
    <section style={PANEL}>
      <h2 style={{ marginTop: 0 }}>Top findings</h2>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading findings…</p>}
      {data && data.errors.length > 0 && (
        <div role="alert">
          <p>
            {data.errors.length === 1
              ? 'A detector'
              : `${data.errors.length} detectors`}{' '}
            failed, so the findings may be incomplete.
          </p>
          <ul>
            {data.errors.map((failed) => (
              <li key={failed.detector}>
                <strong>{failed.detector}</strong>: {failed.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data && data.findings.length === 0 && data.errors.length === 0 && (
        <p>No findings under the current filters.</p>
      )}
      {top.length > 0 && (
        <ol aria-label="Top findings" style={{ paddingLeft: 20 }}>
          {top.map((finding) => (
            <li key={finding.id} style={{ overflowWrap: 'anywhere' }}>
              <Link
                to={`/_usage/findings/${encodeURIComponent(finding.id)}${search}`}
              >
                {finding.subject}
              </Link>{' '}
              {finding.kind === 'never-read-section' ? (
                <>({finding.kind})</>
              ) : (
                <>
                  ({finding.kind}, {finding.count.toLocaleString('en-US')}{' '}
                  {finding.kind === 'stale-hot-section' ? 'reads' : 'events'})
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      <p>
        <Link to={`/_usage/findings${search}`}>All findings</Link>
      </p>
    </section>
  );
}

function hasNoEvents(totals: Totals): boolean {
  return (
    totals.commands === 0 &&
    totals.injected_events === 0 &&
    totals.bypass_reads === 0 &&
    totals.tokens.messages === 0
  );
}

export function OverviewPage(_props: UsagePageProps): ReactElement {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<UsageOverview>('/api/usage');
  return (
    <section>
      <h1>Overview</h1>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading usage…</p>}
      {data && hasNoEvents(data.totals) && search !== '' && (
        <p>No events match the current filters.</p>
      )}
      {data && hasNoEvents(data.totals) && search === '' && (
        <p>
          No usage events yet. To start tracking, run{' '}
          <code>lat usage enable</code>.
        </p>
      )}
      {data && !hasNoEvents(data.totals) && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns:
                'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
            }}
          >
            <NetTokensSaved summary={data} />
            <SignalTiles summary={data} search={search} />
          </div>
          <CommandsPerDay summary={data} />
          <TopFindings search={search} />
        </div>
      )}
      {data && hasNoEvents(data.totals) && <TopFindings search={search} />}
    </section>
  );
}
