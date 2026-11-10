import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  FieldFilters,
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
import {
  fetchAllUsageEvents,
  useUsageData,
  type QueryParams,
  type UsageData,
} from '../use-usage-data';

const MAX_IDS = 50;
const WRAP = { overflowWrap: 'anywhere' } as const;
const SCROLL = { overflowX: 'auto', maxWidth: '100%' } as const;

type Selection = FieldFilters;
type FieldValue = string | number | null;

// A null section or error class is unknown only with a recorded reason. Without
// one there is no value: a lat search names no section, a success no error.
const REASONED: readonly FacetField[] = ['section_id', 'error_class'];
const missingLabel = (field: FacetField) =>
  REASONED.includes(field) ? 'none' : 'unknown';

function hasReason(record: RawRecord, field: 'section_id' | 'error_class') {
  return record.type === 'usage' && !!record.event.unknown_reasons?.[field];
}

function newestFirst(a: RawRecord, b: RawRecord): number {
  return Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : -1);
}

function mergeRecords(current: RawRecord[], page: RawRecord[]): RawRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of page) byId.set(record.id, record);
  return [...byId.values()].sort(newestFirst);
}

/** The server filters: ticked facet values, as `where.<field>`, and the selected event ids. */
function selectionParams(
  selection: Selection,
  ids: string[],
  except?: FacetField,
): QueryParams {
  const params: QueryParams = {};
  for (const field of FACET_FIELDS) {
    const values = selection[field];
    if (field !== except && values?.length) params[`where.${field}`] = values;
  }
  if (ids.length > 0) params.ids = ids.join(',');
  return params;
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
                    hasReason(record, 'section_id') ? (
                      'unknown'
                    ) : (
                      '—'
                    )
                  ) : (
                    (path ?? 'n/a')
                  )}
                </td>
                <td>
                  {record.type === 'usage' ? record.event.exit_code : 'n/a'}
                </td>
                <td>
                  {record.type === 'usage'
                    ? (record.event.error_class ??
                      (hasReason(record, 'error_class') ? 'unknown' : '—'))
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
  field,
  params,
}: {
  field: FacetField;
  params: QueryParams;
}) {
  const { data: facet, error } = useUsageData<RawFacet>('/api/usage/raw', {
    ...params,
    facet: field,
  });
  const empty =
    facet &&
    facet.values.length + facet.missing + facet.unknown + facet.lacking === 0;
  return (
    <>
      {error && <p role="alert">{error.message}</p>}
      {!facet && !error && <p>Loading events…</p>}
      {empty && <p>No events match the current filters.</p>}
      {facet && !empty && (
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
                  <td>{missingLabel(field)}</td>
                  <td>{facet.missing}</td>
                </tr>
              )}
              {facet.unknown > 0 && (
                <tr>
                  <td>unknown</td>
                  <td>{facet.unknown}</td>
                </tr>
              )}
              {facet.lacking > 0 && (
                <tr>
                  <td>n/a (session events have no {field})</td>
                  <td>{facet.lacking}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
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
      {facet.missing > 0 && (
        <div>
          {missingLabel(field)} ({facet.missing})
        </div>
      )}
      {facet.unknown > 0 && <div>unknown ({facet.unknown})</div>}
    </fieldset>
  );
}

function FacetSlot({
  field,
  selection,
  ids,
  onToggle,
}: {
  field: FacetField;
  selection: Selection;
  ids: string[];
  onToggle: (field: FacetField, value: string) => void;
}) {
  // A facet counts over the other fields' ticks, so its own values stay listed.
  const { data: facet, error } = useUsageData<RawFacet>('/api/usage/raw', {
    ...selectionParams(selection, ids, field),
    facet: field,
  });
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

/** Loads the page after a cursor and reports it, so the first page stays loaded and live beside it. */
function OlderEvents({
  params,
  cursor,
  onPage,
}: {
  params: QueryParams;
  cursor: string;
  onPage: (page: UsageData<RawEventsPage>) => void;
}) {
  const page = useUsageData<RawEventsPage>('/api/usage/raw', {
    ...params,
    cursor,
  });
  useEffect(() => onPage(page), [page, onPage]);
  return null;
}

function PagedEvents({
  params,
  filterSearch,
}: {
  params: QueryParams;
  filterSearch: string;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [older, setOlder] = useState<UsageData<RawEventsPage>>();
  const [records, setRecords] = useState<RawRecord[]>([]);
  const loaded = useRef<RawRecord[]>([]);
  loaded.current = records;
  const first = useUsageData<RawEventsPage>('/api/usage/raw', params);
  const { data, error, loading } = first;
  const lastPage = cursor ? older : first;
  const awaitingOlder = !!cursor && !older?.data && !older?.error;
  const nextCursor =
    lastPage?.data?.next_cursor ?? (awaitingOlder ? cursor : undefined);
  const loadingMore = first.loading || !!older?.loading;
  const failure = error ?? older?.error;
  useEffect(() => {
    if (!data) return;
    const oldest = data.next_cursor ? data.records.at(-1) : undefined;
    const newestLoaded = loaded.current[0];
    // More new events than one page leave a gap no cursor reaches: start over.
    if (
      oldest &&
      newestLoaded &&
      oldest.id !== newestLoaded.id &&
      newestFirst(oldest, newestLoaded) < 0
    ) {
      setCursor(undefined);
      setOlder(undefined);
      setRecords(data.records);
      return;
    }
    setRecords((current) => {
      // The first page replaces its own range, so a row that stopped matching
      // leaves, while the older pages already loaded stay.
      const outside = oldest
        ? current.filter((record) => newestFirst(record, oldest) > 0)
        : [];
      return mergeRecords(outside, data.records);
    });
  }, [data]);
  useEffect(() => {
    if (older?.data) {
      const page = older.data.records;
      setRecords((current) => mergeRecords(current, page));
    }
  }, [older?.data]);
  return (
    <>
      {failure && <p role="alert">{failure.message}</p>}
      {loading && records.length === 0 && <p>Loading events…</p>}
      {data && data.records.length === 0 && records.length === 0 && (
        <p>No events match the current filters.</p>
      )}
      {data && records.length > 0 && <p>{data.total} events</p>}
      {records.length > 0 && (
        <EventTable records={records} filterSearch={filterSearch} />
      )}
      {cursor && (
        <OlderEvents params={params} cursor={cursor} onPage={setOlder} />
      )}
      {nextCursor && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => setCursor(nextCursor)}
        >
          Load more events
        </button>
      )}
    </>
  );
}

export function ExplorePage() {
  const { filters } = useUsageFilters();
  const { pathname, search } = useUsageLocation();
  const [selection, setSelection] = useState<Selection>({});
  const [groupBy, setGroupBy] = useState<FacetField | ''>('');
  const [exportError, setExportError] = useState<string | undefined>();

  const allEventIds = [
    ...new Set(new URLSearchParams(search).getAll('event')),
  ].filter(Boolean);
  const eventIds = allEventIds.slice(0, MAX_IDS);
  const filterQuery = filtersToSearchParams(filters).toString();
  const filterSearch = filterQuery ? `?${filterQuery}` : '';
  const filterParams = useMemo(
    () => Object.fromEntries(new URLSearchParams(filterQuery)),
    [filterQuery],
  );
  const picked = FACET_FIELDS.some((field) => selection[field]?.length);
  const params = selectionParams(selection, eventIds);
  const requestKey = `${filterQuery}|${JSON.stringify(params)}`;

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
      const exported = await fetchAllUsageEvents({
        ...filterParams,
        ...params,
      });
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
      </p>
      {allEventIds.length > 0 && (
        <p>
          Showing {eventIds.length} selected{' '}
          {eventIds.length === 1 ? 'event' : 'events'}
          {allEventIds.length > eventIds.length &&
            `, the first ${MAX_IDS} of ${allEventIds.length}`}{' '}
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
              selection={selection}
              ids={eventIds}
              onToggle={toggle}
            />
          ))}
        </aside>
        <div style={{ flex: '3 1 20rem', minWidth: 0 }}>
          {groupBy === '' ? (
            <PagedEvents
              key={requestKey}
              params={params}
              filterSearch={filterSearch}
            />
          ) : (
            <GroupTable key={requestKey} field={groupBy} params={params} />
          )}
        </div>
      </div>
    </section>
  );
}
