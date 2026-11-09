import { type MouseEvent, type ReactNode } from 'react';
import type {
  HealthSignals,
  IssueRow,
  Row,
  SessionRow,
  UsageSummary,
} from '../../../../src/fork/usage/aggregate-types';
import { EntityTable, type EntityColumn } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';

const WRAP = { overflowWrap: 'anywhere' } as const;

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

const issuePath = (id: string, search: string) =>
  `/_usage/issues/${encodeURIComponent(id)}${search}`;
const sessionPath = (id: string, search: string) =>
  `/_usage/sessions/${encodeURIComponent(id)}${search}`;

const percent = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number) => value.toLocaleString('en-US');

/** Issues grouped under their bd parent; an issue whose parent has no row is top level. */
function groupByParent(issues: IssueRow[]): {
  topLevel: IssueRow[];
  childrenOf: (id: string) => IssueRow[];
} {
  const ids = new Set(issues.map((issue) => issue.key));
  const parentOf = new Map(
    issues.map((issue) => [issue.key, issue.parent] as const),
  );
  // A parent cycle (a self-parent is one) has no top; its first key becomes top level.
  const cutAt = new Set<string>();
  for (const { key } of issues) {
    const path: string[] = [];
    let current: string | null | undefined = key;
    while (current != null && ids.has(current) && !path.includes(current)) {
      path.push(current);
      current = parentOf.get(current);
    }
    if (current != null && path.includes(current))
      cutAt.add(path.slice(path.indexOf(current)).sort()[0]);
  }
  const children = new Map<string, IssueRow[]>();
  const topLevel: IssueRow[] = [];
  for (const issue of issues) {
    if (issue.parent !== null && ids.has(issue.parent) && !cutAt.has(issue.key))
      children.set(issue.parent, [
        ...(children.get(issue.parent) ?? []),
        issue,
      ]);
    else topLevel.push(issue);
  }
  return { topLevel, childrenOf: (id) => children.get(id) ?? [] };
}

const CORRELATION = 'correlation, not cause';

/** The label every net tokens saved figure carries, with the method version when the summary has one. */
function savingsLabel(summary: UsageSummary): string {
  const savings = summary.extensions?.savings as
    | { method_version?: unknown }
    | undefined;
  const version = savings?.method_version;
  return typeof version === 'string' || typeof version === 'number'
    ? `${CORRELATION}, method ${version}`
    : CORRELATION;
}

function issueName(issue: Row): string {
  return issue.label === issue.key ? issue.key : `${issue.key} ${issue.label}`;
}

type Measure = {
  key: string;
  header: string;
  value: (stats: IssueRow | IssueRow['rolled_up']) => number | null;
  format?: (value: number | string) => string;
};

const MEASURES: Measure[] = [
  { key: 'commands', header: 'Lat commands', value: (s) => s.totals.commands },
  {
    key: 'success',
    header: 'Search success',
    value: (s) => s.signals.search_success,
    format: (v) => percent(Number(v)),
  },
  {
    key: 'bypass',
    header: 'Bypass reads',
    value: (s) => s.totals.bypass_reads,
  },
  {
    key: 'saved',
    header: 'Net tokens saved',
    value: (s) => s.signals.net_tokens_saved,
  },
  { key: 'sessions', header: 'Sessions', value: (s) => s.totals.sessions },
];

const COLUMNS: EntityColumn<IssueRow>[] = [
  { key: 'name', header: 'Issue', value: issueName },
  { key: 'type', header: 'Type', value: (i) => i.issue_type },
  { key: 'status', header: 'Status', value: (i) => i.status },
  ...MEASURES.flatMap((measure): EntityColumn<IssueRow>[] => [
    {
      key: measure.key,
      header: measure.header,
      value: (i) => measure.value(i),
      format: measure.format,
      numeric: true,
    },
    {
      key: `rolled-${measure.key}`,
      header: `${measure.header} (rolled up)`,
      value: (i) => measure.value(i.rolled_up),
      format: measure.format,
      numeric: true,
    },
  ]),
];

function describeSignal(signals: HealthSignals): Record<string, string> {
  const { lat_commands_per_session, search_success, bypass_rate } = signals;
  const saved = signals.net_tokens_saved;
  return {
    'Lat commands per session':
      lat_commands_per_session === null
        ? 'unknown'
        : lat_commands_per_session.toLocaleString('en-US', {
            maximumFractionDigits: 1,
          }),
    'Search success':
      search_success === null ? 'unknown' : percent(search_success),
    'Bypass rate': bypass_rate === null ? 'unknown' : percent(bypass_rate),
    'Net tokens saved':
      saved !== null
        ? count(saved)
        : `unknown${
            signals.net_tokens_saved_reason
              ? ` (${signals.net_tokens_saved_reason})`
              : ''
          }`,
  };
}

/** Activity matched to no issue. Its own table: the entity table has no pinned rows. */
function UnattributedRow({ row, label }: { row: Row; label: string }) {
  const signals = describeSignal(row.signals);
  return (
    <div
      role="region"
      aria-label="Unattributed activity"
      tabIndex={0}
      style={{ overflowX: 'auto', maxWidth: '100%', marginBottom: '1rem' }}
    >
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <caption style={{ textAlign: 'left' }}>
          Net tokens saved: {label}
        </caption>
        <thead>
          <tr>
            {[
              'Activity',
              'Lat commands',
              'Search success',
              'Bypass reads',
              'Net tokens saved',
              'Sessions',
            ].map((header) => (
              <th
                key={header}
                scope="col"
                style={{ textAlign: 'left', padding: '0.375rem 0.5rem' }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: '0.375rem 0.5rem' }}>Unattributed</td>
            <td>{count(row.totals.commands)}</td>
            <td>{signals['Search success']}</td>
            <td>{count(row.totals.bypass_reads)}</td>
            <td>{signals['Net tokens saved']}</td>
            <td>{count(row.totals.sessions)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function IssuesTable({
  issues,
  search,
}: {
  issues: IssueRow[];
  search: string;
}) {
  const { filters } = useUsageFilters();
  const { topLevel, childrenOf } = groupByParent(issues);
  return (
    <EntityTable<IssueRow>
      label="Issues"
      columns={COLUMNS}
      rows={topLevel}
      rowKey={(issue) => issue.key}
      childRows={(issue) => childrenOf(issue.key)}
      href={(issue) => issuePath(issue.key, search)}
      activeFilters={Object.entries(filters).map(
        ([name, value]) => `${name}: ${value}`,
      )}
      defaultSort={{ key: 'rolled-commands', direction: 'descending' }}
    />
  );
}

function IssueDetail({
  id,
  data,
  search,
}: {
  id: string;
  data: UsageSummary | undefined;
  search: string;
}) {
  const issue = data?.issues.find((row) => row.key === id);
  const { childrenOf } = groupByParent(data?.issues ?? []);
  const childIssues = childrenOf(id);
  const inside = new Set<string>();
  const collect = (key: string) => {
    if (inside.has(key)) return;
    inside.add(key);
    childrenOf(key).forEach((child) => collect(child.key));
  };
  collect(id);
  const sessions: SessionRow[] =
    data?.sessions.filter((session) =>
      session.issues.some((key) => inside.has(key)),
    ) ?? [];
  return (
    <section>
      <p>
        <Link to={`/_usage/issues${search}`}>Issues</Link>
      </p>
      <h1 style={WRAP}>{issue ? issueName(issue) : id}</h1>
      {data && !issue && (
        <p>This issue is not in the summary under the current filters.</p>
      )}
      {issue && (
        <>
          <p style={WRAP}>
            Type {issue.issue_type}, status {issue.status}. Signals cover this
            issue and its descendants.
          </p>
          <h2>Health signals</h2>
          <dl role="group" aria-label="Health signals">
            {Object.entries(describeSignal(issue.rolled_up.signals)).map(
              ([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd style={WRAP}>
                    {value}
                    {name === 'Net tokens saved' && ` (${savingsLabel(data!)})`}
                  </dd>
                </div>
              ),
            )}
          </dl>
          <h2>Child issues</h2>
          {childIssues.length === 0 ? (
            <p>No child issues with activity.</p>
          ) : (
            <ul aria-label="Child issues">
              {childIssues.map((child) => (
                <li key={child.key}>
                  <Link to={issuePath(child.key, search)}>
                    {issueName(child)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <h2>Sessions</h2>
          {sessions.length === 0 ? (
            <p>No sessions worked on this issue.</p>
          ) : (
            <ul aria-label="Sessions">
              {sessions.map((session) => (
                <li key={session.key}>
                  <Link to={sessionPath(session.key, search)}>
                    {session.name ?? session.key}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function IssuesPage({ id }: UsagePageProps) {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<UsageSummary>('/api/usage');
  return (
    <section>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading issues…</p>}
      {id !== undefined && data && (
        <IssueDetail id={id} data={data} search={search} />
      )}
      {id !== undefined && !data && !loading && (
        <IssueDetail id={id} data={undefined} search={search} />
      )}
      {data && id === undefined && (
        <>
          <h1>Issues</h1>
          <UnattributedRow row={data.unattributed} label={savingsLabel(data)} />
          <p>Net tokens saved in the table: {savingsLabel(data)}.</p>
          {data.issues.length === 0 ? (
            <p>No issues under the current filters.</p>
          ) : (
            <IssuesTable issues={data.issues} search={search} />
          )}
        </>
      )}
    </section>
  );
}
