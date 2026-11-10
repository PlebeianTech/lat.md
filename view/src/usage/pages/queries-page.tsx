import { type MouseEvent, type ReactNode } from 'react';
import {
  type QueryDetailRow,
  type QueryRow,
  type UsageOverview,
} from '../../../../src/fork/usage/aggregate-types';
import { Sparkline, type SparklinePoint } from '../charts/sparkline';
import { EntityTable } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';

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

function QueryEvents({ row, search }: { row: QueryDetailRow; search: string }) {
  const { opened_ranks, reformulated_to } = row.facts;
  return (
    <>
      <h2>Sections returned</h2>
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
                    {Object.hasOwn(opened_ranks, section.section_id)
                      ? opened_ranks[section.section_id].join(', ')
                      : 'none'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Reformulations</h2>
      {reformulated_to.length === 0 ? (
        <p>
          No search followed this query within a minute in the same session.
        </p>
      ) : (
        <ul aria-label="Reformulations">
          {reformulated_to.map(({ query: next, count: times }) => (
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
      )}
    </>
  );
}

function QueryDetail({
  id,
  row,
  search,
}: {
  id: string;
  row: QueryDetailRow | undefined;
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
          <QueryEvents row={row} search={search} />
        </>
      ) : (
        <p>This query is not in the summary under the current filters.</p>
      )}
    </section>
  );
}

export function QueriesPage({ id }: UsagePageProps) {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<UsageOverview>('/api/usage');
  return (
    <section>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading queries…</p>}
      {data && id !== undefined && (
        <QueryDetail
          id={id}
          row={data.queries.find((q) => q.key === id)}
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
