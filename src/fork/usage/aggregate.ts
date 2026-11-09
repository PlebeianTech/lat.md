/**
 * Incremental aggregation of usage events into the totals that `lat usage`,
 * the live endpoints and the dashboard show.
 *
 * REGISTRATION POINT. A later issue adds its numbers by appending ONE entry
 * to `contributions` at the bottom of this file, plus an import for it in the
 * import block. A Contribution gets the whole filtered view (AggregateContext)
 * and returns its result, which lands in `UsageSummary.extensions[key]`. The
 * savings contribution (lat-eah.33) also supplies `netTokensSaved`, which
 * fills the signal of the same name on every agent, session and issue row.
 * An optional `prepare(context)` runs (awaited) before any row is built, for
 * async data that the synchronous `netTokensSaved` needs; a throwing prepare
 * is reported like a throwing compute. Nothing else in this file changes for
 * a contribution. Append in the order
 * lat-eah.34, .33, .36, .39, .40. A contribution's own file imports its
 * types and helpers (Item, isSectionRead, computeTotals, median, group, ...)
 * from ./aggregate-types.js, never from this file, so there is no cycle. A
 * contribution that throws is reported under its key as { error } and does
 * not stop the summary.
 *
 * Rules every contribution inherits:
 * - A null counter is unknown and is never added as 0.
 * - An event's issue ids hold only the most specific issues; ancestors get
 *   it through the rollup. A shared event counts in full for each issue, so
 *   never sum per-issue totals into a grand total: use `items`.
 * - session_end, model and session_name are latest-wins per session.
 */
export type * from './aggregate-types.js';
export { normalizeQuery } from './aggregate-types.js';
import {
  attributeActivity,
  createBdWatcher,
  type Activity,
  type BdSnapshot,
} from './bd-attribution.js';
import {
  DAY_MS,
  REFORMULATION_WINDOW_MS,
  compareItems,
  dayOf,
  isCommand,
  isSectionRead,
  startOfDay,
  type AggregateContext,
  type Aggregator,
  type AggregatorOptions,
  type Contribution,
  type Item,
  type Model,
  type Sequence,
  type SessionFacts,
  type UsageSummary,
} from './aggregate-types.js';
import { graphSnapshotContribution } from './graph-snapshot.js';
import { missConsequencesContribution } from './miss-consequences.js';
import { missedKnowledgeContribution } from './missed-knowledge.js';
import { savingsContribution } from './savings.js';
import { sectionScorecardContribution } from './section-scorecard.js';
import {
  View,
  buildAgents,
  buildDocuments,
  buildIssues,
  buildQueries,
  buildSections,
  buildSessions,
  byCommandsThenKey,
} from './aggregate-rows.js';
import { usageEnabled } from './enabled.js';
import {
  filtersKey,
  resolveRange,
  type TimeSpan,
  type UsageFilters,
} from './filters.js';
import { readLog, readSessions } from './ingest.js';
import { sessionSources } from './sources/index.js';
import {
  loadState,
  saveState,
  type SlimSessionEvent,
  type UsageState,
} from './state.js';

function buildSessionFacts(state: UsageState, items: Item[]) {
  const facts = new Map<string, SessionFacts>();
  const factsFor = (id: string): SessionFacts => {
    let fact = facts.get(id);
    if (!fact) {
      fact = {
        agent: null,
        name: null,
        model: null,
        parent: null,
        start: null,
        end: null,
      };
      facts.set(id, fact);
    }
    return fact;
  };
  const earliest = (fact: SessionFacts, ts: number) => {
    fact.start = fact.start === null ? ts : Math.min(fact.start, ts);
  };
  for (const { agent, event } of Object.values(state.sessions)) {
    const fact = factsFor(event.session_id);
    fact.agent = fact.agent ?? agent;
    fact.parent = fact.parent ?? event.parent_session_id ?? null;
    const ts = Date.parse(event.ts);
    if (event.kind === 'session_start') earliest(fact, ts);
    else if (event.kind === 'session_end') fact.end = ts;
    else if (event.kind === 'session_name') fact.name = event.name;
    else if (event.kind === 'model') fact.model = event.model;
  }
  const startedBy = new Set(
    Object.values(state.sessions)
      .filter(({ event }) => event.kind === 'session_start')
      .map(({ event }) => event.session_id),
  );
  for (const item of items) {
    if (!item.session_id) continue;
    const fact = factsFor(item.session_id);
    fact.agent = fact.agent ?? item.agent;
    fact.parent = fact.parent ?? item.usage?.parent_session_id ?? null;
    if (!startedBy.has(item.session_id)) earliest(fact, item.ts);
  }
  return facts;
}

function buildSequence(items: Item[]): Sequence {
  const sequence: Sequence = {
    reads: new Map(),
    followed: new Set(),
    reformulated: new Set(),
    readsBySearch: new Map(),
  };
  const lastSearch = new Map<string, Item>();
  for (const item of items) {
    const usage = item.usage;
    if (!usage || !isCommand(item) || !item.session_id) {
      if (isSectionRead(item) && usage)
        sequence.reads.set(item.id, { rank: null, searchId: null });
      continue;
    }
    const previous = lastSearch.get(item.session_id);
    if (usage.command === 'search') {
      if (previous && item.ts - previous.ts <= REFORMULATION_WINDOW_MS)
        sequence.reformulated.add(previous.id);
      lastSearch.set(item.session_id, item);
    }
    if (usage.section_id === null) continue;
    const index = previous?.usage?.result_ids.indexOf(usage.section_id) ?? -1;
    if (previous && index >= 0) {
      sequence.reads.set(item.id, { rank: index + 1, searchId: previous.id });
      sequence.followed.add(previous.id);
      const opened = sequence.readsBySearch.get(previous.id) ?? [];
      opened.push({ sectionId: usage.section_id, rank: index + 1 });
      sequence.readsBySearch.set(previous.id, opened);
    } else sequence.reads.set(item.id, { rank: null, searchId: null });
  }
  return sequence;
}

function buildModel(state: UsageState, snapshot: BdSnapshot | null): Model {
  const agentBySession = new Map<string, string>();
  for (const { agent, event } of Object.values(state.sessions))
    agentBySession.set(event.session_id, agent);
  const items: Item[] = [];
  for (const usage of Object.values(state.usage)) {
    const ts = Date.parse(usage.ts);
    items.push({
      id: usage.event_id,
      ts,
      day: dayOf(ts),
      session_id: usage.session_id,
      agent: usage.agent ?? agentBySession.get(usage.session_id ?? '') ?? null,
      usage,
      session: null,
    });
  }
  const sessionEvents: SlimSessionEvent[] = [];
  for (const { agent, event } of Object.values(state.sessions)) {
    sessionEvents.push(event);
    if (event.kind !== 'token_usage' && event.kind !== 'bypass_read') continue;
    const ts = Date.parse(event.ts);
    items.push({
      id: event.event_id,
      ts,
      day: dayOf(ts),
      session_id: event.session_id,
      agent,
      usage: null,
      session: event,
    });
  }
  items.sort(compareItems);
  const activity: Activity[] = items.map((item) => ({
    event_id: item.id,
    session_id: item.session_id,
    parent_session_id:
      item.usage?.parent_session_id ?? item.session?.parent_session_id,
    ts: new Date(item.ts).toISOString(),
  }));
  const attribution = attributeActivity(activity, sessionEvents, snapshot);
  const rolledIssues = new Map<string, Set<string>>();
  for (const [issueId, { rolled_up }] of attribution.rollup)
    for (const eventId of rolled_up) {
      const issues = rolledIssues.get(eventId) ?? new Set<string>();
      issues.add(issueId);
      rolledIssues.set(eventId, issues);
    }
  return {
    items,
    sessionEvents,
    sessionFacts: buildSessionFacts(state, items),
    snapshot,
    attribution,
    rolledIssues,
    sequence: buildSequence(items),
  };
}

function matches(filters: UsageFilters, model: Model) {
  const sessionIds = new Set<string>();
  if (filters.session !== undefined)
    for (const [id, fact] of model.sessionFacts)
      if (id === filters.session || fact.name === filters.session)
        sessionIds.add(id);
  return (item: Item): boolean =>
    (filters.agent === undefined ||
      (item.agent ?? 'unknown') === filters.agent) &&
    (filters.session === undefined ||
      (item.session_id !== null && sessionIds.has(item.session_id))) &&
    (filters.issue === undefined ||
      (model.rolledIssues.get(item.id)?.has(filters.issue) ?? false));
}

function inSpan(item: Item, from: number | null, to: number | null) {
  return (from === null || item.ts >= from) && (to === null || item.ts < to);
}

function rangeDays(
  from: number | null,
  to: number | null,
  now: number,
  allItems: Item[],
): string[] {
  if (allItems.length === 0) return [];
  const first = allItems[0].ts;
  const last = allItems[allItems.length - 1].ts;
  const start = startOfDay(Math.max(from ?? first, first));
  const effectiveEnd = to ?? (from === null ? null : now);
  const end =
    effectiveEnd === null
      ? startOfDay(last) + DAY_MS
      : Math.min(effectiveEnd, startOfDay(Math.max(now, last)) + DAY_MS);
  const days: string[] = [];
  for (let day = start; day < end; day += DAY_MS) days.push(dayOf(day));
  return days;
}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

export async function createAggregator(
  options: AggregatorOptions,
): Promise<Aggregator> {
  const { root } = options;
  const sources = options.sources ?? sessionSources;
  const bd = options.bd ?? createBdWatcher();
  const registered = options.contributions ?? contributions;
  const now = options.now ?? Date.now;
  const state = loadState(root);
  let model: Model | null = null;
  let snapshot: BdSnapshot | null = null;
  const memos = new Map<string, Promise<unknown>>();

  function invalidate(): void {
    memos.clear();
  }

  function memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const known = memos.get(key) as Promise<T> | undefined;
    if (known) return known;
    const result = compute();
    memos.set(key, result);
    result.catch(() => {
      if (memos.get(key) === result) memos.delete(key);
    });
    return result;
  }

  // @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]
  async function refresh(): Promise<void> {
    const enabled = usageEnabled(root);
    const logChanged = enabled && readLog(root, state);
    const sessionsChanged =
      enabled && (await readSessions(root, sources, state));
    const latest = await bd.refresh();
    if (logChanged || sessionsChanged) saveState(root, state);
    if (
      logChanged ||
      sessionsChanged ||
      latest !== snapshot ||
      model === null
    ) {
      snapshot = latest;
      model = buildModel(state, latest);
      invalidate();
    }
  }

  // @lat: [[usage-aggregate#Usage Aggregate#Summaries are memoized per data version]]
  async function summary(filters: UsageFilters = {}): Promise<UsageSummary> {
    if (model === null) await refresh();
    return memo(`summary\0${dayOf(now())}\0${filtersKey(filters)}`, () =>
      compute(model!, filters),
    );
  }

  async function compute(
    current: Model,
    filters: UsageFilters,
  ): Promise<UsageSummary> {
    const time = resolveRange(filters, now());
    const keep = matches(filters, current);
    const filtered = current.items.filter(keep);
    const items = filtered.filter((item) => inSpan(item, time.from, time.to));
    const previousSpan: TimeSpan | null = time.previous;
    const previousItems = previousSpan
      ? filtered.filter((item) =>
          inSpan(item, previousSpan.from, previousSpan.to),
        )
      : null;
    const days = rangeDays(time.from, time.to, now(), filtered);
    const context: AggregateContext = {
      root,
      filters,
      days,
      now: now(),
      items,
      previousItems,
      allItems: current.items,
      sessionEvents: current.sessionEvents,
      snapshot: current.snapshot,
      attribution: current.attribution,
      rolledIssues: current.rolledIssues,
    };
    const errors = new Map<string, string>();
    const message = (error: unknown) =>
      error instanceof Error ? error.message : String(error);
    const active: Contribution[] = [];
    for (const contribution of registered)
      try {
        await contribution.prepare?.(context);
        active.push(contribution);
      } catch (error) {
        errors.set(contribution.key, message(error));
        active.push({
          ...contribution,
          netTokensSaved: () => {
            throw new Error(errors.get(contribution.key));
          },
        });
      }
    const view = new View(current, context, active, items, previousItems);
    const overall = view.stats(items, previousItems);
    const { issues, unattributed } = buildIssues(view);
    const extensions: Record<string, unknown> = {};
    for (const contribution of registered)
      try {
        if (errors.has(contribution.key))
          throw new Error(errors.get(contribution.key));
        extensions[contribution.key] = await contribution.compute(context);
      } catch (error) {
        extensions[contribution.key] = { error: message(error) };
      }
    return {
      filters,
      range: {
        from: iso(time.from),
        to: iso(time.to),
        previous_from: iso(previousSpan?.from ?? null),
        previous_to: iso(previousSpan?.to ?? null),
      },
      days,
      ...overall,
      agents: buildAgents(view, state.reasons),
      sessions: buildSessions(view),
      issues,
      unattributed,
      commands: view
        .rows(
          (item) => (isCommand(item) ? [item.usage!.command] : []),
          (key) => key,
        )
        .sort(byCommandsThenKey),
      queries: buildQueries(view),
      sections: buildSections(view),
      documents: buildDocuments(view),
      byDay: view
        .rows(
          (item) => [item.day],
          (key) => key,
        )
        .sort((a, b) => a.key.localeCompare(b.key)),
      extensions,
    };
  }

  return { refresh, summary, memo, invalidate };
}

/** Append one Contribution per later issue here; see the header. */
// prettier-ignore
export const contributions: Contribution[] = [
  // One entry per line, each ending in a comma. Append below this line.
  graphSnapshotContribution,
  savingsContribution,
  missedKnowledgeContribution,
  sectionScorecardContribution,
  missConsequencesContribution,
];
