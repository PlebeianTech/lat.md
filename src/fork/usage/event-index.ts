/**
 * An in-memory index of raw usage events and session events, for the raw
 * events endpoint and the dashboard pages that list events.
 *
 * The index keeps its own UsageState and never saves it: the logs are read
 * from their offsets and the session transcripts from the readers'
 * checkpoints, once per process, and nothing is copied to disk. Records hold
 * stored fields only. A session tool call keeps its `source` pointer and no
 * shell command; a consumer that needs the text re-reads that line.
 */
import {
  attributeActivity,
  createBdWatcher,
  type Attribution,
  type AttributionResult,
  type BdSnapshot,
  type BdWatcher,
} from './bd-attribution.js';
import { usageEnabled } from './enabled.js';
import { resolveRange, type UsageFilters } from './filters.js';
import { readLog, readSessions } from './ingest.js';
import type { UsageEvent } from './schema.js';
import { sessionSources } from './sources/index.js';
import { emptyState, type SlimSessionEvent, type UsageState } from './state.js';
import type { SessionSource } from './sources/types.js';
import {
  FACET_FIELDS,
  MAX_FACET_VALUES,
  type FacetField,
} from './raw-facets.js';

export const MAX_PAGE_SIZE = 200;
export { FACET_FIELDS, MAX_FACET_VALUES, type FacetField };

/** Fields that only a UsageEvent has. */
const USAGE_ONLY_FIELDS = new Set<FacetField>([
  'command',
  'caller',
  'surface',
  'section_id',
  'error_class',
  'exit_code',
]);

interface RawRecordBase {
  /** event_id of the event. */
  id: string;
  ts: string;
  agent: string | null;
  session_id: string | null;
  /** The most specific bd issues the event served; ancestors roll up. */
  issue_ids: string[];
  attribution: Attribution['method'];
}

export type RawRecord = RawRecordBase &
  (
    | { type: 'usage'; event: UsageEvent }
    | { type: 'session'; event: SlimSessionEvent }
  );

/** Response of GET /api/usage/raw. */
export interface RawEventsPage {
  /** Newest first. */
  records: RawRecord[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
}

/** Response of GET /api/usage/raw?facet=<field>. */
export interface RawFacet {
  field: FacetField;
  /** The most frequent values of the filtered records, at most 20. */
  values: { value: string | number; count: number }[];
  /** Records of the kinds that have the field, where it is null. */
  missing: number;
}

export interface EventIndexOptions {
  root: string;
  sources?: SessionSource[];
  bd?: Pick<BdWatcher, 'refresh'>;
}

export interface PageOptions extends EventIndexOptions {
  /** Only records with these event ids. */
  ids?: string[];
  cursor?: string;
  /** At most MAX_PAGE_SIZE, which is also the default. */
  limit?: number;
}

interface Model {
  /** Newest first. */
  records: RawRecord[];
  rolledIssues: Map<string, Set<string>>;
  sessionNames: Map<string, string>;
}

interface Index {
  enabled: boolean;
  state: UsageState;
  sources: SessionSource[];
  bd: Pick<BdWatcher, 'refresh'>;
  snapshot: BdSnapshot | null;
  model: Model | null;
  queue: Promise<unknown>;
}

const indexes = new Map<string, Index>();

function newestFirst(a: RawRecord, b: RawRecord): number {
  return Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : -1);
}

function buildModel(state: UsageState, snapshot: BdSnapshot | null): Model {
  const agentBySession = new Map<string, string>();
  const sessionNames = new Map<string, string>();
  const sessionEvents: SlimSessionEvent[] = [];
  for (const { agent, event } of Object.values(state.sessions)) {
    agentBySession.set(event.session_id, agent);
    if (event.kind === 'session_name')
      sessionNames.set(event.session_id, event.name);
    sessionEvents.push(event);
  }
  const records: RawRecord[] = [];
  for (const event of Object.values(state.usage))
    records.push({
      type: 'usage',
      id: event.event_id,
      ts: event.ts,
      agent: event.agent ?? agentBySession.get(event.session_id ?? '') ?? null,
      session_id: event.session_id,
      issue_ids: [],
      attribution: 'unattributed',
      event,
    });
  for (const { agent, event } of Object.values(state.sessions))
    records.push({
      type: 'session',
      id: event.event_id,
      ts: event.ts,
      agent,
      session_id: event.session_id,
      issue_ids: [],
      attribution: 'unattributed',
      event,
    });
  const attribution: AttributionResult = attributeActivity(
    records.map((record) => ({
      event_id: record.id,
      session_id: record.session_id,
      parent_session_id: record.event.parent_session_id ?? undefined,
      ts: record.ts,
    })),
    sessionEvents,
    snapshot,
  );
  for (const record of records) {
    const found = attribution.attributions.get(record.id);
    if (!found) continue;
    record.issue_ids = found.issue_ids;
    record.attribution = found.method;
  }
  const rolledIssues = new Map<string, Set<string>>();
  for (const [issueId, { rolled_up }] of attribution.rollup)
    for (const eventId of rolled_up) {
      const issues = rolledIssues.get(eventId) ?? new Set<string>();
      issues.add(issueId);
      rolledIssues.set(eventId, issues);
    }
  return { records: records.sort(newestFirst), rolledIssues, sessionNames };
}

async function currentModel(options: EventIndexOptions): Promise<Model> {
  let index = indexes.get(options.root);
  if (!index) {
    index = {
      enabled: usageEnabled(options.root),
      state: emptyState(),
      sources: options.sources ?? sessionSources,
      bd: options.bd ?? createBdWatcher(),
      snapshot: null,
      model: null,
      queue: Promise.resolve(),
    };
    indexes.set(options.root, index);
  }
  const current = index;
  const run = current.queue.then(async () => {
    const enabled = usageEnabled(options.root);
    if (enabled !== current.enabled) {
      // Off lists no events; on again re-reads from the start.
      current.enabled = enabled;
      current.state = emptyState();
      current.model = null;
    }
    const logChanged = enabled && readLog(options.root, current.state);
    const sessionsChanged =
      enabled &&
      (await readSessions(options.root, current.sources, current.state));
    const latest = await current.bd.refresh();
    if (
      logChanged ||
      sessionsChanged ||
      latest !== current.snapshot ||
      current.model === null
    ) {
      current.snapshot = latest;
      current.model = buildModel(current.state, latest);
    }
    return current.model;
  });
  current.queue = run.catch(() => undefined);
  return run;
}

function matches(filters: UsageFilters, model: Model, now: number) {
  const { from, to } = resolveRange(filters, now);
  const sessionIds = new Set<string>();
  if (filters.session !== undefined) {
    sessionIds.add(filters.session);
    for (const [id, name] of model.sessionNames)
      if (name === filters.session) sessionIds.add(id);
  }
  return (record: RawRecord): boolean => {
    const ts = Date.parse(record.ts);
    return (
      (from === null || ts >= from) &&
      (to === null || ts < to) &&
      (filters.agent === undefined ||
        (record.agent ?? 'unknown') === filters.agent) &&
      (filters.session === undefined ||
        (record.session_id !== null && sessionIds.has(record.session_id))) &&
      (filters.issue === undefined ||
        (model.rolledIssues.get(record.id)?.has(filters.issue) ?? false))
    );
  };
}

async function filtered(
  filters: UsageFilters,
  options: EventIndexOptions & { ids?: string[] },
): Promise<RawRecord[]> {
  const model = await currentModel(options);
  const keep = matches(filters, model, Date.now());
  const wanted = options.ids ? new Set(options.ids) : null;
  return model.records.filter(
    (record) => keep(record) && (wanted === null || wanted.has(record.id)),
  );
}

function encodeCursor(record: RawRecord): string {
  return Buffer.from(`${Date.parse(record.ts)}|${record.id}`).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { ts: number; id: string } {
  const [ts, ...rest] = Buffer.from(cursor, 'base64url').toString().split('|');
  const id = rest.join('|');
  if (!/^-?\d+$/.test(ts ?? '') || id === '')
    throw new Error(`Invalid cursor: ${cursor}`);
  return { ts: Number(ts), id };
}

/** One page of the records that match the filters, newest first. */
export async function queryUsageEvents(
  filters: UsageFilters,
  options: PageOptions,
): Promise<RawEventsPage> {
  const limit = options.limit ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(`Invalid limit: ${limit}`);
  const size = Math.min(limit, MAX_PAGE_SIZE);
  let records = await filtered(filters, options);
  if (options.cursor !== undefined) {
    const after = decodeCursor(options.cursor);
    records = records.filter((record) => {
      const ts = Date.parse(record.ts);
      return ts < after.ts || (ts === after.ts && record.id < after.id);
    });
  }
  const pageRecords = records.slice(0, size);
  return {
    records: pageRecords,
    next_cursor:
      records.length > size
        ? encodeCursor(pageRecords[pageRecords.length - 1])
        : null,
  };
}

/** The most frequent values of one field over the matching records. */
export async function facetUsageEvents(
  filters: UsageFilters,
  field: FacetField,
  options: EventIndexOptions,
): Promise<RawFacet> {
  if (!FACET_FIELDS.includes(field))
    throw new Error(`Unknown facet field: ${field}`);
  const counts = new Map<string | number, number>();
  let missing = 0;
  for (const record of await filtered(filters, options)) {
    if (record.type === 'session' && USAGE_ONLY_FIELDS.has(field)) continue;
    const value: string | number | null =
      field === 'agent' || field === 'session_id'
        ? record[field]
        : record.type === 'usage'
          ? record.event[field]
          : null;
    if (value === null) missing++;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const values = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (a, b) =>
        b.count - a.count || String(a.value).localeCompare(String(b.value)),
    )
    .slice(0, MAX_FACET_VALUES);
  return { field, values, missing };
}
