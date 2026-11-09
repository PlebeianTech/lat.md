import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  REFORMULATION_WINDOW_MS,
  normalizeQuery,
  type QueryRow,
  type UsageSummary,
} from '../../../../src/fork/usage/aggregate-types';
import type { RawRecord } from '../../../../src/fork/usage/event-index';
import { Sparkline, type SparklinePoint } from '../charts/sparkline';
import { EntityTable } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { fetchAllUsageEvents, useUsageData } from '../use-usage-data';

const WRAP = { overflowWrap: 'anywhere' } as const;

const percent = (value: number | null) =>
  value === null ? 'unknown' : `${Math.round(value * 100)}%`;
const count = (value: number | null) =>
  value === null ? 'unknown' : value.toLocaleString('en-US');

/** The current filters as a query string with its leading "?", or empty. */
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

const queryPath = (query: string, search: string) =>
  `/_usage/queries/${encodeURIComponent(query)}${search}`;
const sectionPath = (sectionId: string, search: string) =>
  `/_usage/knowledge/${encodeURIComponent(sectionId)}${search}`;

function searchesPerDay(row: QueryRow): SparklinePoint[] {
  return row.daily.map((point) => ({ day: point.day, value: point.searches }));
}

function QueriesList({
  queries,
  search,
}: {
  queries: QueryRow[];
  search: string;
}) {
  const { filters } = useUsageFilters();
  return (
    <EntityTable<QueryRow>
      label="Queries"
      columns={[
        { key: 'query', header: 'Query', value: (q) => q.key },
        {
          key: 'count',
          header: 'Searches',
          value: (q) => q.count,
          numeric: true,
        },
        {
          key: 'sessions',
          header: 'Sessions',
          value: (q) => q.sessions,
          numeric: true,
        },
        {
          key: 'results',
          header: 'Median results',
          value: (q) => q.result_count,
          numeric: true,
        },
        {
          key: 'empty',
          header: 'Empty-result share',
          value: (q) => q.empty_share,
          format: (v) => percent(Number(v)),
          numeric: true,
        },
        {
          key: 'followed',
          header: 'Followed by a read',
          value: (q) => q.follow_through_share,
          format: (v) => percent(Number(v)),
          numeric: true,
        },
        {
          key: 'rank',
          header: 'Median rank opened',
          value: (q) => q.median_rank_opened,
          numeric: true,
        },
        {
          key: 'reformulations',
          header: 'Reformulations',
          value: (q) => q.reformulations,
          numeric: true,
        },
      ]}
      rows={queries}
      rowKey={(q) => q.key}
      href={(q) => queryPath(q.key, search)}
      trend={{ header: 'Searches per day', points: searchesPerDay }}
      activeFilters={Object.entries(filters).map(
        ([name, value]) => `${name}: ${value}`,
      )}
      defaultSort={{ key: 'count', direction: 'descending' }}
    />
  );
}

interface QueryFacts {
  /** Ranks at which each section was opened after this query, one per read. */
  ranks: Map<string, number[]>;
  /** Searches that followed this one in the same session within the window, by normalized query (null: none recorded), with counts. */
  reformulations: Map<string | null, number>;
}

/**
 * Replays the lat commands of each session in order. The rule is the one of
 * buildSequence in src/fork/usage/aggregate.ts (not exported, so repeated
 * here): keep it identical, or the lists drift from the QueryRow counts.
 */
function replay(records: RawRecord[], target: string): QueryFacts {
  const facts: QueryFacts = { ranks: new Map(), reformulations: new Map() };
  const commands = records
    .filter(
      (record): record is RawRecord & { type: 'usage' } =>
        record.type === 'usage' &&
        record.event.caller !== 'hook-injected' &&
        Boolean(record.session_id),
    )
    .sort(
      (a, b) =>
        Date.parse(a.ts) - Date.parse(b.ts) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const lastSearch = new Map<string, (typeof commands)[number]>();
  for (const record of commands) {
    const { event } = record;
    const previous = lastSearch.get(record.session_id!);
    const previousIsTarget =
      previous?.event.query != null &&
      normalizeQuery(previous.event.query) === target;
    if (event.command === 'search') {
      if (
        previous &&
        previousIsTarget &&
        Date.parse(record.ts) - Date.parse(previous.ts) <=
          REFORMULATION_WINDOW_MS
      ) {
        const next = event.query === null ? null : normalizeQuery(event.query);
        facts.reformulations.set(
          next,
          (facts.reformulations.get(next) ?? 0) + 1,
        );
      }
      lastSearch.set(record.session_id!, record);
    }
    if (event.section_id === null || !previous || !previousIsTarget) continue;
    const index = previous.event.result_ids.indexOf(event.section_id);
    if (index < 0) continue;
    const ranks = facts.ranks.get(event.section_id) ?? [];
    ranks.push(index + 1);
    facts.ranks.set(event.section_id, ranks);
  }
  for (const ranks of facts.ranks.values()) ranks.sort((a, b) => a - b);
  return facts;
}

function QueryEvents({
  row,
  refresh,
  search,
}: {
  row: QueryRow;
  /** Changes when the summary is refetched, so the events reload with it. */
  refresh: unknown;
  search: string;
}) {
  const { filters } = useUsageFilters();
  const key = filtersToSearchParams(filters).toString();
  const [events, setEvents] = useState<RawRecord[] | undefined>();
  const [error, setError] = useState<Error | undefined>();

  useEffect(() => {
    let current = true;
    fetchAllUsageEvents(Object.fromEntries(new URLSearchParams(key))).then(
      (records) => {
        if (!current) return;
        setEvents(records);
        setError(undefined);
      },
      (failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
      },
    );
    return () => {
      current = false;
    };
  }, [key, refresh]);

  const facts = useMemo(
    () => (events ? replay(events, row.key) : undefined),
    [events, row.key],
  );
  const reformulated = facts
    ? [...facts.reformulations].sort(
        (a, b) => b[1] - a[1] || (a[0] ?? '').localeCompare(b[0] ?? ''),
      )
    : [];
  return (
    <>
      <h2>Sections returned</h2>
      {error && <p role="alert">{error.message}</p>}
      {!facts && !error && <p>Loading events…</p>}
      {row.sections_returned.length === 0 ? (
        <p>This query returned no sections.</p>
      ) : (
        <div
          role="region"
          aria-label="Sections returned"
          tabIndex={0}
          style={{ overflowX: 'auto', maxWidth: '100%' }}
        >
          <table>
            <thead>
              <tr>
                <th>Section</th>
                <th>Returned</th>
                <th>Opened</th>
                <th>Opened at rank</th>
              </tr>
            </thead>
            <tbody>
              {row.sections_returned.map((section) => (
                <tr key={section.section_id}>
                  <td style={WRAP}>
                    <Link to={sectionPath(section.section_id, search)}>
                      {section.section_id}
                    </Link>
                  </td>
                  <td>{count(section.returned)}</td>
                  <td>{count(section.opened)}</td>
                  <td>
                    {facts
                      ? (facts.ranks.get(section.section_id)?.join(', ') ??
                        'none')
                      : 'unknown'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Reformulations</h2>
      {!facts && <p>unknown</p>}
      {facts &&
        (reformulated.length === 0 ? (
          <p>
            No search followed this query within a minute in the same session.
          </p>
        ) : (
          <ul aria-label="Reformulations">
            {reformulated.map(([next, times]) => (
              <li key={next ?? ''} style={WRAP}>
                {next === null ? (
                  'no query recorded'
                ) : (
                  <Link to={queryPath(next, search)}>{next}</Link>
                )}{' '}
                ({count(times)})
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}

function QueryDetail({
  id,
  row,
  refresh,
  search,
}: {
  id: string;
  row: QueryRow | undefined;
  refresh: unknown;
  search: string;
}) {
  return (
    <section>
      <p>
        <Link to={`/_usage/queries${search}`}>Queries</Link>
      </p>
      <h1 style={WRAP}>{row?.key ?? id}</h1>
      {row ? (
        <>
          <p aria-label="Query summary" style={WRAP}>
            {count(row.count)} searches in {count(row.sessions)} sessions.
            Median results {count(row.result_count)}; empty-result share{' '}
            {percent(row.empty_share)}; followed by a read{' '}
            {percent(row.follow_through_share)}; median rank opened{' '}
            {count(row.median_rank_opened)}; reformulated{' '}
            {count(row.reformulations)} times.
          </p>
          <Sparkline
            label={`Searches per day: ${row.key}`}
            points={searchesPerDay(row)}
          />
          <QueryEvents row={row} refresh={refresh} search={search} />
        </>
      ) : (
        <p>This query is not in the summary under the current filters.</p>
      )}
    </section>
  );
}

export function QueriesPage({ id }: UsagePageProps) {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<UsageSummary>('/api/usage');
  return (
    <section>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading queries…</p>}
      {data && id !== undefined && (
        <QueryDetail
          id={id}
          row={data.queries.find((q) => q.key === id)}
          refresh={data}
          search={search}
        />
      )}
      {data && id === undefined && (
        <>
          <h1>Queries</h1>
          {data.queries.length === 0 ? (
            <p>No queries under the current filters.</p>
          ) : (
            <QueriesList queries={data.queries} search={search} />
          )}
        </>
      )}
    </section>
  );
}
