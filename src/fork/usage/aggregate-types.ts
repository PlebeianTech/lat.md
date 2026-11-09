/**
 * Public types of the usage aggregation and the pure helpers that
 * contributions share with the row builders: item predicates, totals,
 * grouping, medians and query normalization. No I/O, so a contribution can
 * import this file without a cycle through aggregate.ts.
 */
import type {
  TokenCounter,
  TokenUsage,
  UnknownReason,
  UsageEvent,
} from './schema.js';
import type {
  AttributionResult,
  BdSnapshot,
  BdWatcher,
} from './bd-attribution.js';
import type { UsageFilters } from './filters.js';
import type { SlimSessionEvent } from './state.js';
import type { SessionSource } from './sources/types.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REFORMULATION_WINDOW_MS = 60_000;
export const TOKEN_COUNTERS: TokenCounter[] = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
];

/** One thing that happened: a lat command, a token message or a bypass read. */
export interface Item {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  session_id: string | null;
  agent: string | null;
  /** Set for a lat command or hook injection. */
  usage: UsageEvent | null;
  /** Set for a token_usage or bypass_read event. */
  session: SlimSessionEvent | null;
}

/** A sum of the known values; unknown values are counted, never added. */
export interface CountedSum {
  /** Null when nothing is known but something is unknown. */
  total: number | null;
  known: number;
  unknown: number;
}

export interface Totals {
  /** Lat commands: events that are not hook injections. */
  commands: number;
  sessions: number;
  searches: number;
  zero_result_searches: number;
  searches_unknown_results: number;
  /** Searches whose results a later read opened. */
  followed_searches: number;
  /** Searches followed by another search in the session within 60 seconds. */
  reformulated_searches: number;
  section_reads: number;
  bypass_reads: number;
  errors: number;
  injected_events: number;
  injected_bytes: CountedSum;
  bytes_out: CountedSum;
  latency_ms: { p50: number | null; p95: number | null };
  tokens: {
    messages: number;
    input: CountedSum;
    output: CountedSum;
    cache_read: CountedSum;
    cache_write: CountedSum;
    reasoning: CountedSum;
    reported_cost_usd: CountedSum;
  };
  zero_result_rate: number | null;
  follow_through_rate: number | null;
  reformulation_rate: number | null;
  bypass_rate: number | null;
  median_rank_opened: number | null;
}

export type DailyPoint = Totals & { day: string };

export interface HealthSignals {
  lat_commands_per_session: number | null;
  search_success: number | null;
  bypass_rate: number | null;
  /** Null until a contribution supplies it (lat-eah.33). */
  net_tokens_saved: number | null;
  /** Set when a contribution threw while computing net tokens saved. */
  net_tokens_saved_reason: string | null;
  /** The cost side of net tokens, kept apart from it. */
  injected_bytes: CountedSum;
}

export interface Stats {
  totals: Totals;
  /** Same row over the previous range; null without a `from` filter. */
  previous: Totals | null;
  /** One point per UTC day of the range. */
  daily: DailyPoint[];
  signals: HealthSignals;
}

export interface Row extends Stats {
  key: string;
  label: string;
}

export interface RolledRow extends Row {
  /** Own totals are in the row; this adds descendants. */
  rolled_up: Stats;
}

export interface AgentRow extends Row {
  /** Why the agent's reader supplied no data; null when it read normally. */
  reason: UnknownReason | null;
}

export interface SessionRow extends RolledRow {
  agent: string | null;
  name: string | null;
  model: string | null;
  parent_session_id: string | null;
  children: string[];
  start: string | null;
  end: string | null;
  duration_ms: number | null;
  /** The most specific bd issues the session worked on. */
  issues: string[];
}

export interface IssueRow extends RolledRow {
  status: string;
  issue_type: string;
  /** The bd parent issue, which may carry no activity and so have no row; null at the top. */
  parent: string | null;
}

export interface QueryRow extends Row {
  count: number;
  sessions: number;
  /** Median of the known result counts. */
  result_count: number | null;
  empty_share: number | null;
  follow_through_share: number | null;
  median_rank_opened: number | null;
  sections_returned: { section_id: string; returned: number; opened: number }[];
  reformulations: number;
}

export interface SectionRow extends Row {
  document: string;
  reads: number;
  reads_by_day: { day: string; reads: number }[];
  /** Queries whose search led to a read. */
  queries: { query: string; count: number }[];
  /** Issues, with ancestors, whose sessions read the section. */
  issues: string[];
}

export interface DocumentRow extends Row {
  reads: number;
  sections_read: number;
}

/** Response of GET /api/usage. */
export interface UsageSummary {
  filters: UsageFilters;
  range: {
    from: string | null;
    to: string | null;
    previous_from: string | null;
    previous_to: string | null;
  };
  days: string[];
  /** Counted from the events: never the sum of the issue rows. */
  totals: Totals;
  previous: Totals | null;
  daily: DailyPoint[];
  signals: HealthSignals;
  agents: AgentRow[];
  sessions: SessionRow[];
  issues: IssueRow[];
  unattributed: Row;
  commands: Row[];
  queries: QueryRow[];
  sections: SectionRow[];
  documents: DocumentRow[];
  byDay: Row[];
  /** Results of the registered contributions, by key. */
  extensions: Record<string, unknown>;
}

/** What a contribution sees: the filtered view and the unfiltered facts. */
export interface AggregateContext {
  root: string;
  filters: UsageFilters;
  days: string[];
  now: number;
  /** Items in the filtered range. */
  items: Item[];
  /** Items in the previous range; null without a `from` filter. */
  previousItems: Item[] | null;
  allItems: Item[];
  /** Every stored session event except the repeated kinds' older copies. */
  sessionEvents: SlimSessionEvent[];
  snapshot: BdSnapshot | null;
  attribution: AttributionResult;
  /** Issue ids, with ancestors, per item id. */
  rolledIssues: Map<string, Set<string>>;
}

export interface Contribution {
  key: string;
  /**
   * Runs before any row is built, so async data can be loaded for the
   * synchronous `netTokensSaved`. A throw is recorded under the key and
   * `netTokensSaved` then yields null with the error as its reason.
   */
  prepare?(context: AggregateContext): Promise<void> | void;
  compute(context: AggregateContext): unknown | Promise<unknown>;
  /** Supply the net tokens saved for the items of a row; undefined defers. */
  netTokensSaved?(
    items: Item[],
    context: AggregateContext,
  ): number | null | undefined;
}

export interface Aggregator {
  /** Reads new log lines, new session events and the bd snapshot. */
  refresh(): Promise<void>;
  /** Memoized per data version, filters and UTC day. */
  summary(filters?: UsageFilters): Promise<UsageSummary>;
  /** One shared promise per key until the data version changes. */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T>;
  /** Starts a new data version, as if the data had changed. */
  invalidate(): void;
}

export interface AggregatorOptions {
  root: string;
  sources?: SessionSource[];
  bd?: Pick<BdWatcher, 'refresh'>;
  contributions?: Contribution[];
  now?: () => number;
}

export interface ReadFact {
  /** 1-based position in the followed search's result ids. */
  rank: number | null;
  searchId: string | null;
}

/** Facts that depend on event order within a session, over all items. */
export interface Sequence {
  reads: Map<string, ReadFact>;
  followed: Set<string>;
  reformulated: Set<string>;
  readsBySearch: Map<string, { sectionId: string; rank: number }[]>;
}

export interface SessionFacts {
  agent: string | null;
  name: string | null;
  model: string | null;
  parent: string | null;
  start: number | null;
  end: number | null;
}

export interface Model {
  items: Item[];
  sessionEvents: SlimSessionEvent[];
  sessionFacts: Map<string, SessionFacts>;
  snapshot: BdSnapshot | null;
  attribution: AttributionResult;
  rolledIssues: Map<string, Set<string>>;
  sequence: Sequence;
}

export const isCommand = (item: Item) =>
  item.usage !== null && item.usage.caller !== 'hook-injected';
export const isSearch = (item: Item) =>
  isCommand(item) && item.usage?.command === 'search';
export const isSectionRead = (item: Item) =>
  isCommand(item) && item.usage?.section_id != null;

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const startOfDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
export const ratio = (part: number, whole: number) =>
  whole > 0 ? part / whole : null;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function nearestRank(sorted: number[], fraction: number): number | null {
  return sorted.length === 0
    ? null
    : sorted[Math.max(Math.ceil(fraction * sorted.length) - 1, 0)];
}

export class Sum {
  private sum = 0;
  private known = 0;
  private unknown = 0;
  add(value: number | null | undefined) {
    if (value === null || value === undefined) this.unknown++;
    else {
      this.sum += value;
      this.known++;
    }
  }
  result(): CountedSum {
    return {
      total: this.known === 0 && this.unknown > 0 ? null : this.sum,
      known: this.known,
      unknown: this.unknown,
    };
  }
}

export function computeTotals(items: Item[], sequence: Sequence): Totals {
  const sessions = new Set<string>();
  const injectedBytes = new Sum();
  const bytesOut = new Sum();
  const durations: number[] = [];
  const ranks: number[] = [];
  const counters = Object.fromEntries(
    TOKEN_COUNTERS.map((counter) => [counter, new Sum()]),
  ) as Record<TokenCounter, Sum>;
  const cost = new Sum();
  let messages = 0;
  let commands = 0;
  let searches = 0;
  let zero = 0;
  let unknownResults = 0;
  let followed = 0;
  let reformulated = 0;
  let reads = 0;
  let bypass = 0;
  let errors = 0;
  let injectedEvents = 0;

  for (const item of items) {
    if (item.session_id) sessions.add(item.session_id);
    const event = item.session;
    if (event?.kind === 'token_usage') {
      messages++;
      const usage: TokenUsage = event.usage;
      for (const counter of TOKEN_COUNTERS)
        counters[counter].add(usage[counter]);
      cost.add(usage.reported_cost_usd);
      continue;
    }
    if (event?.kind === 'bypass_read') {
      bypass++;
      continue;
    }
    const usage = item.usage;
    if (!usage) continue;
    if (usage.caller === 'hook-injected') {
      injectedEvents++;
      injectedBytes.add(usage.injected_bytes);
      continue;
    }
    commands++;
    durations.push(usage.duration_ms);
    if (usage.exit_code !== 0) errors++;
    bytesOut.add(usage.bytes_out);
    if (usage.command === 'search') {
      searches++;
      if (usage.result_count === null) unknownResults++;
      else if (usage.result_count === 0) zero++;
      if (sequence.followed.has(item.id)) followed++;
      if (sequence.reformulated.has(item.id)) reformulated++;
    }
    if (usage.section_id !== null) {
      reads++;
      const rank = sequence.reads.get(item.id)?.rank;
      if (rank) ranks.push(rank);
    }
  }
  durations.sort((a, b) => a - b);
  return {
    commands,
    sessions: sessions.size,
    searches,
    zero_result_searches: zero,
    searches_unknown_results: unknownResults,
    followed_searches: followed,
    reformulated_searches: reformulated,
    section_reads: reads,
    bypass_reads: bypass,
    errors,
    injected_events: injectedEvents,
    injected_bytes: injectedBytes.result(),
    bytes_out: bytesOut.result(),
    latency_ms: {
      p50: nearestRank(durations, 0.5),
      p95: nearestRank(durations, 0.95),
    },
    tokens: {
      messages,
      input: counters.input.result(),
      output: counters.output.result(),
      cache_read: counters.cache_read.result(),
      cache_write: counters.cache_write.result(),
      reasoning: counters.reasoning.result(),
      reported_cost_usd: cost.result(),
    },
    zero_result_rate: ratio(zero, searches - unknownResults),
    follow_through_rate: ratio(followed, searches),
    reformulation_rate: ratio(reformulated, searches),
    bypass_rate: ratio(bypass, bypass + reads),
    median_rank_opened: median(ranks),
  };
}

export function compareItems(a: Item, b: Item): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function group(items: Item[], keys: (item: Item) => string[]) {
  const groups = new Map<string, Item[]>();
  for (const item of items)
    for (const key of keys(item)) {
      const members = groups.get(key);
      if (members) members.push(item);
      else groups.set(key, [item]);
    }
  return groups;
}
