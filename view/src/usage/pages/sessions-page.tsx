import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  SessionRow,
  UsageSummary,
} from '../../../../src/fork/usage/aggregate-types';
import type { RawRecord } from '../../../../src/fork/usage/event-index';
import { TimelineLanes, type TimelineLane } from '../charts/timeline-lanes';
import { EntityTable } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { fetchAllUsageEvents, useUsageData } from '../use-usage-data';

const WRAP = { overflowWrap: 'anywhere' } as const;

function formatTime(value: string | null): string | null {
  return value === null ? null : value.replace('T', ' ').slice(0, 16);
}

function formatDuration(ms: number | string): string {
  const seconds = Math.round(Number(ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${seconds % 60}s`
    : `${hours}h ${minutes % 60}m`;
}

/**
 * Input plus output tokens of the known messages; null when none is known. A
 * session with no token usage message at all knows nothing, so it is null
 * too, never 0.
 */
function tokensUsed(session: SessionRow): number | null {
  const { messages, input, output } = session.totals.tokens;
  if (messages === 0) return null;
  if (input.total === null && output.total === null) return null;
  return (input.total ?? 0) + (output.total ?? 0);
}

/**
 * Unknown input counts plus unknown output counts. A message with both
 * unknown counts twice. This is not a message count: the summary has no
 * per-message figure, and neither the sum nor the larger of the two equals
 * the number of messages with an unknown count.
 */
function unknownTokenCounts(session: SessionRow): number | null {
  const { messages, input, output } = session.totals.tokens;
  if (messages === 0) return null;
  return input.unknown + output.unknown;
}

/** The known total with its unknown count, or "unknown" when nothing is known. */
function describeTokens(session: SessionRow): string {
  const known = tokensUsed(session);
  if (known === null) return 'unknown';
  const unknown = unknownTokenCounts(session) ?? 0;
  const total = known.toLocaleString('en-US');
  return unknown > 0
    ? `${total} (+${unknown.toLocaleString('en-US')} unknown counts)`
    : total;
}

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

const sessionPath = (id: string, search: string) =>
  `/_usage/sessions/${encodeURIComponent(id)}${search}`;

function sessionName(session: SessionRow): string {
  return session.name ?? session.key;
}

function SessionsList({
  sessions,
  search,
}: {
  sessions: SessionRow[];
  search: string;
}) {
  const { filters } = useUsageFilters();
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const topLevel = sessions.filter(
    (session) =>
      session.parent_session_id === null ||
      !byKey.has(session.parent_session_id),
  );
  return (
    <EntityTable<SessionRow>
      label="Sessions"
      columns={[
        { key: 'name', header: 'Session', value: sessionName },
        { key: 'agent', header: 'Agent', value: (s) => s.agent },
        { key: 'start', header: 'Start', value: (s) => formatTime(s.start) },
        {
          key: 'duration',
          header: 'Duration',
          value: (s) => s.duration_ms,
          format: formatDuration,
          numeric: true,
        },
        {
          key: 'commands',
          header: 'Lat commands',
          value: (s) => s.totals.commands,
          numeric: true,
        },
        {
          key: 'success',
          header: 'Search success',
          value: (s) => s.signals.search_success,
          format: (v) => `${Math.round(Number(v) * 100)}%`,
          numeric: true,
        },
        {
          key: 'bypass',
          header: 'Bypass reads',
          value: (s) => s.totals.bypass_reads,
          numeric: true,
        },
        {
          key: 'tokens',
          header: 'Tokens',
          value: tokensUsed,
          numeric: true,
        },
        {
          key: 'unknown-tokens',
          header: 'Unknown counts',
          value: unknownTokenCounts,
          format: (v) =>
            Number(v) > 0
              ? `+${Number(v).toLocaleString('en-US')} unknown`
              : 'none',
          numeric: true,
        },
        {
          key: 'issues',
          header: 'Issues',
          value: (s) => (s.issues.length ? s.issues.join(', ') : null),
          unknownText: 'none',
        },
      ]}
      rows={topLevel}
      rowKey={(s) => s.key}
      childRows={(s) => s.children.flatMap((child) => byKey.get(child) ?? [])}
      href={(s) => sessionPath(s.key, search)}
      activeFilters={Object.entries(filters).map(
        ([name, value]) => `${name}: ${value}`,
      )}
      defaultSort={{ key: 'start', direction: 'descending' }}
    />
  );
}

const LANES = [
  'Lat commands',
  'Injected context',
  'Bypass reads',
  'bd claims and closes',
] as const;
type LaneName = (typeof LANES)[number];

/** The lane of an event and its label, or null for a kind the timeline leaves out. */
function placeEvent(
  record: RawRecord,
): { lane: LaneName; label: string } | null {
  if (record.type === 'usage') {
    return record.event.surface === 'hook'
      ? // The tap records a hook's command as `hook <event>` already.
        { lane: 'Injected context', label: record.event.command }
      : { lane: 'Lat commands', label: `lat ${record.event.command}` };
  }
  const { event } = record;
  if (event.kind === 'bypass_read')
    return { lane: 'Bypass reads', label: `read ${event.path}` };
  if (event.kind === 'bd_command')
    return {
      lane: 'bd claims and closes',
      label: `bd ${event.verb} ${event.issue_id}`,
    };
  return null;
}

function buildLanes(events: RawRecord[]): {
  lanes: TimelineLane[];
  placed: { record: RawRecord; label: string }[];
} {
  const lanes = LANES.map((label): TimelineLane => ({ label, events: [] }));
  const placed: { record: RawRecord; label: string }[] = [];
  for (const record of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const spot = placeEvent(record);
    if (!spot) continue;
    lanes[LANES.indexOf(spot.lane)].events.push({
      id: record.id,
      label: spot.label,
      start: Date.parse(record.ts),
    });
    placed.push({ record, label: spot.label });
  }
  return { lanes, placed };
}

/** Stored fields of an event, ids, counts, paths and section ids only. */
function eventFields(record: RawRecord): [string, string][] {
  const fields: [string, string | number | null | undefined][] = [
    ['id', record.id],
    ['time', record.ts],
    ['agent', record.agent],
  ];
  if (record.type === 'usage') {
    const { event } = record;
    // "unknown" only when lat recorded a reason; a null with no reason, such
    // as the error class of a successful command, has no value to show.
    const known = (
      field: 'result_count' | 'section_id' | 'error_class' | 'injected_bytes',
    ) => event[field] ?? (event.unknown_reasons?.[field] ? 'unknown' : '—');
    fields.push(
      ['type', `usage (${event.surface})`],
      ['command', event.command],
      ['caller', event.caller],
      ['exit code', event.exit_code],
      ['duration ms', event.duration_ms],
      ['result count', known('result_count')],
      ['section', known('section_id')],
      ['error class', known('error_class')],
      ['injected bytes', known('injected_bytes')],
    );
  } else {
    const { event } = record;
    fields.push(['type', event.kind]);
    if (event.kind === 'bypass_read')
      fields.push(['path', event.path], ['bytes', event.bytes]);
    if (event.kind === 'bd_command')
      fields.push(['verb', event.verb], ['issue', event.issue_id]);
  }
  fields.push(['issues', record.issue_ids.join(', ') || 'none']);
  return fields.map(([name, value]) => [
    name,
    value === null || value === undefined ? 'unknown' : String(value),
  ]);
}

function SessionEvents({
  id,
  refresh,
}: {
  id: string;
  /** Changes when the summary is refetched, so the events reload with it. */
  refresh: unknown;
}) {
  const { filters } = useUsageFilters();
  const query = filtersToSearchParams(filters);
  query.set('session', id);
  const key = query.toString();
  const [events, setEvents] = useState<RawRecord[] | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [reloads, setReloads] = useState(0);
  const seen = useRef(refresh);

  // The first summary only starts the page; a later one means the data changed.
  useEffect(() => {
    if (seen.current !== undefined && refresh !== seen.current)
      setReloads((count) => count + 1);
    seen.current = refresh;
  }, [refresh]);

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
  }, [key, reloads]);

  const { lanes, placed } = buildLanes(events ?? []);
  const chosen = placed.find(({ record }) => record.id === selected)?.record;
  return (
    <section>
      <h2>Timeline</h2>
      {error && <p role="alert">{error.message}</p>}
      {!events && !error && <p>Loading events…</p>}
      {events && (
        <>
          <p>
            Loaded {events.length.toLocaleString('en-US')}{' '}
            {events.length === 1 ? 'event' : 'events'}, showing{' '}
            {placed.length.toLocaleString('en-US')} on the timeline.
          </p>
          <TimelineLanes label="Session timeline" lanes={lanes} />
          {placed.length > 0 && (
            <>
              <h3>Events</h3>
              <ul style={{ maxHeight: '16rem', overflowY: 'auto' }}>
                {placed.map(({ record, label }) => (
                  <li key={record.id} style={WRAP}>
                    <button
                      type="button"
                      aria-pressed={record.id === selected}
                      onClick={() => setSelected(record.id)}
                      style={{ font: 'inherit', ...WRAP }}
                    >
                      {record.id} {label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {chosen && (
            <dl role="group" aria-label="Selected event">
              {eventFields(chosen).map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd style={WRAP}>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

function SessionDetail({
  id,
  session,
  loaded,
  refresh,
  search,
}: {
  id: string;
  session: SessionRow | undefined;
  /** True once the summary has arrived, so a missing session really is missing. */
  loaded: boolean;
  refresh: unknown;
  search: string;
}) {
  return (
    <section>
      <p>
        <Link to={`/_usage/sessions${search}`}>Sessions</Link>
      </p>
      <h1 style={WRAP}>{session ? sessionName(session) : id}</h1>
      {session ? (
        <>
          <p style={WRAP}>
            Session <code>{session.key}</code>, agent{' '}
            {session.agent ?? 'unknown'}, started{' '}
            {formatTime(session.start) ?? 'unknown'}, duration{' '}
            {session.duration_ms === null
              ? 'unknown'
              : formatDuration(session.duration_ms)}
            , {session.totals.commands.toLocaleString('en-US')} lat commands,{' '}
            {session.totals.bypass_reads.toLocaleString('en-US')} bypass reads,
            tokens {describeTokens(session)}.
          </p>
          {session.parent_session_id && (
            <p>
              Subagent of{' '}
              <Link to={sessionPath(session.parent_session_id, search)}>
                {session.parent_session_id}
              </Link>
            </p>
          )}
          {session.children.length > 0 && (
            <p>
              Subagents:{' '}
              {session.children.map((child) => (
                <span key={child}>
                  <Link to={sessionPath(child, search)}>{child}</Link>{' '}
                </span>
              ))}
            </p>
          )}
          {session.issues.length > 0 && (
            <p>
              Issues:{' '}
              {session.issues.map((issue) => (
                <span key={issue}>
                  <Link
                    to={`/_usage/issues/${encodeURIComponent(issue)}${search}`}
                  >
                    {issue}
                  </Link>{' '}
                </span>
              ))}
            </p>
          )}
        </>
      ) : (
        loaded && (
          <p>This session is not in the summary under the current filters.</p>
        )
      )}
      {/* Keyed by id so another session's events never show under this heading. */}
      <SessionEvents key={id} id={id} refresh={refresh} />
    </section>
  );
}

export function SessionsPage({ id }: UsagePageProps) {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<UsageSummary>('/api/usage');
  return (
    <section>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading sessions…</p>}
      {id !== undefined && (
        <SessionDetail
          id={id}
          session={data?.sessions.find((s) => s.key === id)}
          loaded={data !== undefined}
          refresh={data}
          search={search}
        />
      )}
      {data && id === undefined && (
        <>
          <h1>Sessions</h1>
          {data.sessions.length === 0 ? (
            <p>No sessions under the current filters.</p>
          ) : (
            <SessionsList sessions={data.sessions} search={search} />
          )}
        </>
      )}
    </section>
  );
}
