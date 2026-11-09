import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  RawEventsPage,
  RawFacet,
  RawRecord,
} from '../../../../src/fork/usage/event-index';
import {
  FACET_FIELDS,
  MAX_FACET_VALUES,
  type FacetField,
} from '../../../../src/fork/usage/raw-facets';
import {
  filtersToSearchParams,
  navigateTo,
  useUsageFilters,
  useUsageLocation,
} from '../filters';
import { fetchAllUsageEvents, useUsageData } from '../use-usage-data';

const MAX_IDS = 50;
const ROWS_PER_STEP = 200;
const WRAP = { overflowWrap: 'anywhere' } as const;
const SCROLL = { overflowX: 'auto', maxWidth: '100%' } as const;

type Selection = Partial<Record<FacetField, string[]>>;
type FieldValue = string | number | null;

// undefined: the record kind has no such field
function fieldValue(
  record: RawRecord,
  field: FacetField,
): FieldValue | undefined {
  if (field === 'agent' || field === 'session_id') return record[field];
  if (record.type !== 'usage') return undefined;
  return record.event[field];
}

function matchesSelection(
  record: RawRecord,
  selection: Selection,
  except?: FacetField,
): boolean {
  for (const field of FACET_FIELDS) {
    const wanted = selection[field];
    if (field === except || !wanted?.length) continue;
    const value = fieldValue(record, field);
    if (value == null || !wanted.includes(String(value))) return false;
  }
  return true;
}

function countValues(records: RawRecord[], field: FacetField): RawFacet {
  const counts = new Map<string | number, number>();
  let missing = 0;
  for (const record of records) {
    const value = fieldValue(record, field);
    if (value === undefined) continue;
    if (value === null) missing++;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const values = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (a, b) =>
        b.count - a.count || String(a.value).localeCompare(String(b.value)),
    );
  return { field, values: values.slice(0, MAX_FACET_VALUES), missing };
}

function newestFirst(a: RawRecord, b: RawRecord): number {
  return Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : -1);
}

async function loadEvents(
  filterParams: Record<string, string>,
  ids: string[],
): Promise<RawRecord[]> {
  if (ids.length === 0) return fetchAllUsageEvents(filterParams);
  const byId = new Map<string, RawRecord>();
  for (let start = 0; start < ids.length; start += MAX_IDS) {
    const chunk = ids.slice(start, start + MAX_IDS);
    for (const record of await fetchAllUsageEvents({
      ...filterParams,
      ids: chunk.join(','),
    }))
      byId.set(record.id, record);
  }
  return [...byId.values()].sort(newestFirst);
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

const display = (value: FieldValue | undefined) =>
  value === null || value === undefined ? 'unknown' : String(value);

function EventTable({
  records,
  filterSearch,
}: {
  records: RawRecord[];
  filterSearch: string;
}) {
  return (
    <div style={SCROLL}>
      <table data-event-table>
        <caption>Events, newest first</caption>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Agent</th>
            <th>Session</th>
            <th>Command or kind</th>
            <th>Section or path</th>
            <th>Exit code</th>
            <th>Error class</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const sectionId =
              record.type === 'usage' ? record.event.section_id : null;
            const path =
              record.type !== 'session'
                ? null
                : record.event.kind === 'tool_call'
                  ? record.event.tool.path
                  : record.event.kind === 'bypass_read'
                    ? record.event.path
                    : null;
            return (
              <tr key={record.id} data-event-id={record.id}>
                <td>{record.ts}</td>
                <td>{record.type}</td>
                <td>{display(record.agent)}</td>
                <td style={WRAP}>
                  {record.session_id ? (
                    <Link
                      to={`/_usage/sessions/${encodeURIComponent(record.session_id)}${filterSearch}`}
                    >
                      {record.session_id}
                    </Link>
                  ) : (
                    'unknown'
                  )}
                </td>
                <td>
                  {record.type === 'usage'
                    ? record.event.command
                    : record.event.kind}
                </td>
                <td style={WRAP}>
                  {sectionId ? (
                    <Link
                      to={`/_usage/knowledge/${encodeURIComponent(sectionId)}${filterSearch}`}
                    >
                      {sectionId}
                    </Link>
                  ) : record.type === 'usage' ? (
                    'unknown'
                  ) : (
                    (path ?? 'n/a')
                  )}
                </td>
                <td>
                  {record.type === 'usage' ? record.event.exit_code : 'n/a'}
                </td>
                <td>
                  {record.type === 'usage'
                    ? display(record.event.error_class)
                    : 'n/a'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupTable({
  records,
  field,
}: {
  records: RawRecord[];
  field: FacetField;
}) {
  const facet = countValues(records, field);
  const lacking =
    records.length -
    facet.missing -
    records.filter((record) => fieldValue(record, field) != null).length;
  return (
    <div style={SCROLL}>
      <table data-group-table>
        <caption>
          Events by {field}, top {MAX_FACET_VALUES} values
        </caption>
        <thead>
          <tr>
            <th>{field}</th>
            <th>Events</th>
          </tr>
        </thead>
        <tbody>
          {facet.values.map(({ value, count }) => (
            <tr key={String(value)}>
              <td style={WRAP}>{String(value)}</td>
              <td>{count}</td>
            </tr>
          ))}
          {facet.missing > 0 && (
            <tr>
              <td>unknown</td>
              <td>{facet.missing}</td>
            </tr>
          )}
          {lacking > 0 && (
            <tr>
              <td>n/a (session events have no {field})</td>
              <td>{lacking}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function FacetGroup({
  facet,
  selected,
  onToggle,
}: {
  facet: RawFacet;
  selected: string[];
  onToggle: (field: FacetField, value: string) => void;
}) {
  const { field } = facet;
  return (
    <fieldset style={{ minWidth: 0 }}>
      <legend>{field}</legend>
      {facet.values.map(({ value, count }) => (
        <label key={String(value)} style={{ display: 'block', ...WRAP }}>
          <input
            type="checkbox"
            data-facet={field}
            data-value={String(value)}
            checked={selected.includes(String(value))}
            onChange={() => onToggle(field, String(value))}
          />{' '}
          {String(value)} ({count})
        </label>
      ))}
      {facet.missing > 0 && <div>unknown ({facet.missing})</div>}
    </fieldset>
  );
}

function FacetSlot({
  field,
  loadedRecords,
  selection,
  onToggle,
}: {
  field: FacetField;
  loadedRecords: RawRecord[] | undefined;
  selection: Selection;
  onToggle: (field: FacetField, value: string) => void;
}) {
  const { data, error } = useUsageData<RawFacet>('/api/usage/raw', {
    facet: field,
  });
  const facet = loadedRecords
    ? countValues(
        loadedRecords.filter((record) =>
          matchesSelection(record, selection, field),
        ),
        field,
      )
    : data;
  return (
    <>
      {error && field === FACET_FIELDS[0] && (
        <p role="alert">{error.message}</p>
      )}
      {facet && (
        <FacetGroup
          facet={facet}
          selected={selection[field] ?? []}
          onToggle={onToggle}
        />
      )}
    </>
  );
}

function PagedEvents({ filterSearch }: { filterSearch: string }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [records, setRecords] = useState<RawRecord[]>([]);
  const { data, error, loading } = useUsageData<RawEventsPage>(
    '/api/usage/raw',
    cursor ? { cursor } : undefined,
  );
  useEffect(() => {
    if (!data) return;
    setRecords((current) => {
      const byId = new Map(current.map((record) => [record.id, record]));
      for (const record of data.records) byId.set(record.id, record);
      return [...byId.values()].sort(newestFirst);
    });
  }, [data]);
  return (
    <>
      {error && <p role="alert">{error.message}</p>}
      {loading && records.length === 0 && <p>Loading events…</p>}
      {data && data.records.length === 0 && records.length === 0 && (
        <p>No events match the current filters.</p>
      )}
      {records.length > 0 && (
        <EventTable records={records} filterSearch={filterSearch} />
      )}
      {data?.next_cursor && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setCursor(data.next_cursor ?? undefined)}
        >
          Load more events
        </button>
      )}
    </>
  );
}

type Loaded = {
  state: 'loading' | 'error' | 'ready';
  key: string;
  records: RawRecord[];
  message?: string;
};

const NOTHING_LOADED: Loaded = { state: 'loading', key: '', records: [] };

export function ExplorePage() {
  const { filters } = useUsageFilters();
  const { pathname, search } = useUsageLocation();
  const [selection, setSelection] = useState<Selection>({});
  const [groupBy, setGroupBy] = useState<FacetField | ''>('');
  const [visible, setVisible] = useState(ROWS_PER_STEP);
  const [loaded, setLoaded] = useState<Loaded>(NOTHING_LOADED);
  const [exportError, setExportError] = useState<string | undefined>();

  const eventIds = [
    ...new Set(new URLSearchParams(search).getAll('event')),
  ].filter(Boolean);
  const idKey = eventIds.join(',');
  const filterQuery = filtersToSearchParams(filters).toString();
  const filterSearch = filterQuery ? `?${filterQuery}` : '';
  const filterParams = useMemo(
    () => Object.fromEntries(new URLSearchParams(filterQuery)),
    [filterQuery],
  );
  const picked = FACET_FIELDS.some((field) => selection[field]?.length);
  const loadsAll = picked || groupBy !== '' || eventIds.length > 0;
  const requestKey = `${filterQuery}|${idKey}`;
  const heartbeat = useUsageData<RawEventsPage>('/api/usage/raw', {
    limit: '1',
  });

  const runId = useRef(0);
  const inFlight = useRef<string | null>(null);

  useEffect(
    () => () => {
      runId.current++;
      inFlight.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!loadsAll) {
      runId.current++;
      inFlight.current = null;
      setLoaded(NOTHING_LOADED);
      return;
    }
    if (inFlight.current === requestKey) return;
    inFlight.current = requestKey;
    const run = ++runId.current;
    setLoaded((current) =>
      current.key === requestKey
        ? current
        : { state: 'loading', key: requestKey, records: [] },
    );
    loadEvents(filterParams, idKey ? idKey.split(',') : []).then(
      (records) => {
        if (run !== runId.current) return;
        inFlight.current = null;
        setLoaded({ state: 'ready', key: requestKey, records });
      },
      (error: unknown) => {
        if (run !== runId.current) return;
        inFlight.current = null;
        setLoaded((current) => ({
          ...current,
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        }));
      },
    );
  }, [loadsAll, filterParams, idKey, requestKey, heartbeat.data]);

  useEffect(() => setVisible(ROWS_PER_STEP), [requestKey]);

  const current = loaded.key === requestKey ? loaded : NOTHING_LOADED;
  const records = current.records;
  const showsRows = current.state === 'ready' || records.length > 0;
  const narrowed = records.filter((record) =>
    matchesSelection(record, selection),
  );

  function toggle(field: FacetField, value: string) {
    setSelection((current) => {
      const values = current[field] ?? [];
      return {
        ...current,
        [field]: values.includes(value)
          ? values.filter((v) => v !== value)
          : [...values, value],
      };
    });
  }

  function clearSelectedEvents() {
    const rest = new URLSearchParams(search);
    rest.delete('event');
    const query = rest.toString();
    navigateTo(query ? `${pathname}?${query}` : pathname);
  }

  async function exportEvents() {
    setExportError(undefined);
    try {
      const exported = (
        await loadEvents(filterParams, idKey ? idKey.split(',') : [])
      ).filter((record) => matchesSelection(record, selection));
      const blob = new Blob(
        [exported.map((record) => JSON.stringify(record)).join('\n') + '\n'],
        { type: 'application/x-ndjson' },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'usage-events.jsonl';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section>
      <h1>Explore</h1>
      <p>
        Raw events, newest first. Facet lists and group-by show the top{' '}
        {MAX_FACET_VALUES} values.
        {loadsAll &&
          ' Ticked facets and group-by read every event of the current filters.'}
      </p>
      {eventIds.length > 0 && (
        <p>
          Showing {eventIds.length} selected{' '}
          {eventIds.length === 1 ? 'event' : 'events'}{' '}
          <button type="button" onClick={clearSelectedEvents}>
            Clear selection
          </button>
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <label>
          Group by{' '}
          <select
            aria-label="Group by"
            value={groupBy}
            onChange={(event) =>
              setGroupBy(event.target.value as FacetField | '')
            }
          >
            <option value="">No grouping</option>
            {FACET_FIELDS.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={exportEvents}>
          Export JSON lines
        </button>
        {picked && (
          <button type="button" onClick={() => setSelection({})}>
            Clear facets
          </button>
        )}
      </div>
      {exportError && <p role="alert">{exportError}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <aside aria-label="Facets" style={{ flex: '1 1 14rem', minWidth: 0 }}>
          {FACET_FIELDS.map((field) => (
            <FacetSlot
              key={field}
              field={field}
              loadedRecords={loadsAll && showsRows ? records : undefined}
              selection={selection}
              onToggle={toggle}
            />
          ))}
        </aside>
        <div style={{ flex: '3 1 20rem', minWidth: 0 }}>
          {!loadsAll && (
            <PagedEvents key={filterQuery} filterSearch={filterSearch} />
          )}
          {loadsAll && current.state === 'loading' && <p>Loading events…</p>}
          {loadsAll && current.state === 'error' && (
            <p role="alert">{current.message}</p>
          )}
          {loadsAll && showsRows && (
            <>
              <p>{narrowed.length} events</p>
              {narrowed.length === 0 && (
                <p>No events match the current filters.</p>
              )}
              {narrowed.length > 0 && groupBy !== '' && (
                <GroupTable records={narrowed} field={groupBy} />
              )}
              {narrowed.length > 0 && groupBy === '' && (
                <>
                  <EventTable
                    records={narrowed.slice(0, visible)}
                    filterSearch={filterSearch}
                  />
                  {narrowed.length > visible && (
                    <button
                      type="button"
                      onClick={() => setVisible(visible + ROWS_PER_STEP)}
                    >
                      Show more events
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
