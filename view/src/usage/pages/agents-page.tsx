import type {
  AgentRow,
  UsageOverview,
} from '../../../../src/fork/usage/aggregate-types';
import { BarList, type BarListItem } from '../charts/bar-list';
import { EntityTable } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';

const AGENTS = ['claude', 'codex', 'antigravity', 'pi', 'opencode'];
const CORRELATION = 'correlation, not cause';

/** One agent on the page; `row` is null when the summary has no row for it. */
type Entry = { key: string; row: AgentRow | null };

const sessionsOf = (entry: Entry) => entry.row?.totals.sessions ?? 0;

/** The summary's rows for the five agents in order, then any other agent it reports. */
function entriesOf(agents: AgentRow[]): Entry[] {
  const byKey = new Map(agents.map((row) => [row.key, row]));
  const keys = [...AGENTS, ...agents.map((a) => a.key)].filter(
    (key, index, all) => all.indexOf(key) === index,
  );
  return keys.map((key) => ({ key, row: byKey.get(key) ?? null }));
}

/** A per-session figure; null for an agent with no sessions or an unknown figure. */
function perSession(
  entry: Entry,
  value: (row: AgentRow) => number | null,
): number | null {
  if (!entry.row || sessionsOf(entry) === 0) return null;
  return value(entry.row);
}

/** A share of searches or reads; null for an agent with no row or an unknown share. */
function ratio(
  entry: Entry,
  value: (row: AgentRow) => number | null,
): number | null {
  return entry.row ? value(entry.row) : null;
}

function percent(share: number | null): number | null {
  return share === null ? null : Math.round(share * 100);
}

function savedPerSession(entry: Entry): number | null {
  return perSession(entry, (row) =>
    row.signals.net_tokens_saved === null
      ? null
      : Math.round(row.signals.net_tokens_saved / sessionsOf(entry)),
  );
}

function savingsLabel(summary: UsageOverview): string {
  const savings = summary.extensions?.savings as
    | { method_version?: unknown }
    | undefined;
  const version = savings?.method_version;
  return typeof version === 'string' || typeof version === 'number'
    ? `${CORRELATION}, method ${version}`
    : CORRELATION;
}

function describePercent(value: number | null): string {
  return value === null ? 'unknown' : `${value}%`;
}

function savedText(entry: Entry): string {
  const saved = entry.row?.signals.net_tokens_saved;
  if (saved === null || saved === undefined) {
    const reason = entry.row?.signals.net_tokens_saved_reason;
    return reason ? `unknown (${reason})` : 'unknown';
  }
  return saved.toLocaleString('en-US');
}

const agentColor = (key: string) =>
  AGENTS.includes(key) ? `var(--agent-${key})` : undefined;

function bars(
  entries: Entry[],
  value: (entry: Entry) => number | null,
): BarListItem[] {
  return entries.map((entry) => ({
    label: entry.key,
    value: value(entry),
    color: agentColor(entry.key),
  }));
}

function Charts({
  entries,
  summary,
}: {
  entries: Entry[];
  summary: UsageOverview;
}) {
  const signal = (pick: (row: AgentRow) => number | null) => (entry: Entry) =>
    perSession(entry, pick);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
        gap: 16,
      }}
    >
      <BarList
        label="Lat commands per session"
        items={bars(
          entries,
          signal((row) => row.signals.lat_commands_per_session),
        )}
      />
      <BarList
        label="Search hit rate (%)"
        items={bars(entries, (entry) =>
          ratio(entry, (row) => percent(row.signals.search_hit_rate)),
        )}
      />
      <BarList
        label="Bypass rate (%)"
        items={bars(entries, (entry) =>
          ratio(entry, (row) => percent(row.signals.bypass_rate)),
        )}
      />
      <BarList
        label={`Net tokens saved per session (${savingsLabel(summary)})`}
        items={bars(entries, savedPerSession)}
      />
    </div>
  );
}

function AgentsTable({
  entries,
  summary,
}: {
  entries: Entry[];
  summary: UsageOverview;
}) {
  const { filters } = useUsageFilters();
  const overviewFor = (agent: string) => {
    const query = filtersToSearchParams({ ...filters, agent }).toString();
    return `/_usage?${query}`;
  };
  return (
    <EntityTable<Entry>
      label="Agents"
      columns={[
        {
          key: 'agent',
          header: 'Agent',
          value: (e) =>
            sessionsOf(e) === 0 ? `${e.key} (no sessions in range)` : e.key,
        },
        {
          key: 'sessions',
          header: 'Sessions',
          value: sessionsOf,
          numeric: true,
        },
        {
          key: 'commands',
          header: 'Commands per session',
          value: (e) =>
            perSession(e, (r) => r.signals.lat_commands_per_session),
          format: (v) =>
            Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }),
          numeric: true,
        },
        {
          key: 'hit-rate',
          header: 'Search hit rate',
          value: (e) => ratio(e, (r) => percent(r.signals.search_hit_rate)),
          format: (v) => describePercent(Number(v)),
          numeric: true,
        },
        {
          key: 'bypass',
          header: 'Bypass rate',
          value: (e) => ratio(e, (r) => percent(r.signals.bypass_rate)),
          format: (v) => describePercent(Number(v)),
          numeric: true,
        },
        {
          key: 'saved',
          header: `Net tokens saved per session (${savingsLabel(summary)})`,
          value: savedPerSession,
          numeric: true,
        },
      ]}
      rows={entries}
      rowKey={(e) => e.key}
      href={(e) => overviewFor(e.key)}
      activeFilters={Object.entries(filters).map(
        ([name, value]) => `${name}: ${value}`,
      )}
    />
  );
}

export function AgentsPage(_props: UsagePageProps) {
  const { data, error, loading } = useUsageData<UsageOverview>('/api/usage');
  const entries = data ? entriesOf(data.agents) : [];
  return (
    <section>
      <h1>Agents</h1>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading agents…</p>}
      {data && (
        <>
          {entries.every((entry) => sessionsOf(entry) === 0) && (
            <p>No agent sessions under the current filters.</p>
          )}
          <Charts entries={entries} summary={data} />
          <AgentsTable entries={entries} summary={data} />
          <ReasonList entries={entries} />
        </>
      )}
    </section>
  );
}

/** Why an agent's reader supplied no data, and why net tokens saved is unknown. */
function ReasonList({ entries }: { entries: Entry[] }) {
  const notes = entries.flatMap((entry) => {
    const lines: string[] = [];
    if (entry.row?.reason)
      lines.push(`${entry.key}: no data (${entry.row.reason})`);
    const savedReason = entry.row?.signals.net_tokens_saved_reason;
    if (
      (sessionsOf(entry) > 0 || savedReason) &&
      savedText(entry).startsWith('unknown')
    )
      lines.push(`${entry.key}: net tokens saved ${savedText(entry)}`);
    return lines;
  });
  if (notes.length === 0) return null;
  return (
    <ul aria-label="Unknown values" style={{ overflowWrap: 'anywhere' }}>
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
