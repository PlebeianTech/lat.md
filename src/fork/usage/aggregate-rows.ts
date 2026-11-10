/** Row builders: one function per breakdown of the usage summary. */
import { SESSION_AGENTS } from './sources/types.js';
import type { UnknownReason } from './schema.js';
import {
  computeTotals,
  group,
  isSearch,
  isSectionRead,
  median,
  normalizeQuery,
  ratio,
  type AgentRow,
  type AggregateContext,
  type Contribution,
  type DocumentRow,
  type HealthSignals,
  type IssueRow,
  type Item,
  type Model,
  type QueryRow,
  type Row,
  type SectionRow,
  type SessionRow,
  type Stats,
  type Totals,
} from './aggregate-types.js';

export const byCommandsThenKey = (a: Row, b: Row) =>
  b.totals.commands - a.totals.commands || a.key.localeCompare(b.key);

export class View {
  constructor(
    readonly model: Model,
    readonly context: AggregateContext,
    readonly contributions: Contribution[],
    readonly items: Item[],
    readonly previousItems: Item[] | null,
  ) {}

  totals(items: Item[]): Totals {
    return computeTotals(items, this.model.sequence);
  }

  signals(items: Item[], totals: Totals): HealthSignals {
    let netTokensSaved: number | null = null;
    let reason: string | null = null;
    for (const contribution of this.contributions) {
      try {
        const saved = contribution.netTokensSaved?.(items, this.context);
        if (saved !== undefined) {
          netTokensSaved = saved;
          reason = null;
          break;
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      lat_commands_per_session: totals.lat_commands_per_session,
      search_hit_rate: totals.search_hit_rate,
      follow_through_rate: totals.follow_through_rate,
      bypass_rate: totals.bypass_rate,
      net_tokens_saved: netTokensSaved,
      net_tokens_saved_reason: reason,
      injected_bytes: totals.injected_bytes,
    };
  }

  stats(items: Item[], previous: Item[] | null): Stats {
    const totals = this.totals(items);
    const byDay = group(items, (item) => [item.day]);
    return {
      totals,
      previous: previous ? this.totals(previous) : null,
      daily: this.context.days.map((day) => ({
        day,
        ...this.totals(byDay.get(day) ?? []),
      })),
      signals: this.signals(items, totals),
    };
  }

  /** A row for each key of the current items, with the items it was built from. */
  entries(
    keys: (item: Item) => string[],
    label: (key: string) => string,
    fixed: string[] = [],
  ): { row: Row; items: Item[] }[] {
    const current = group(this.items, keys);
    const previous = this.previousItems && group(this.previousItems, keys);
    for (const key of fixed) if (!current.has(key)) current.set(key, []);
    return [...current].map(([key, items]) => ({
      items,
      row: {
        key,
        label: label(key),
        ...this.stats(items, previous ? (previous.get(key) ?? []) : null),
      },
    }));
  }

  /** A row for each key of the current items; `fixed` keys always get one. */
  rows(
    keys: (item: Item) => string[],
    label: (key: string) => string,
    fixed: string[] = [],
  ): Row[] {
    return this.entries(keys, label, fixed).map(({ row }) => row);
  }
}

export function readsByKey(view: View, key: (item: Item) => string | null) {
  return group(view.items.filter(isSectionRead), (item) => {
    const value = key(item);
    return value === null ? [] : [value];
  });
}

export function sectionOf(item: Item): string | null {
  return item.usage?.section_id ?? null;
}

export const documentOf = (sectionId: string) => sectionId.split('#')[0];

export function buildAgents(
  view: View,
  reasons: Record<string, UnknownReason | null>,
) {
  const known: string[] = [...SESSION_AGENTS];
  const rows = view.rows(
    (item) => [item.agent ?? 'unknown'],
    (key) => key,
    known,
  );
  const rank = (row: Row) =>
    row.key === 'unknown'
      ? known.length + 1
      : known.indexOf(row.key) >= 0
        ? known.indexOf(row.key)
        : known.length;
  // @lat: [[usage-aggregate#Usage Aggregate#An agent name never collides with an object property]]
  const reasonOf = (agent: string) =>
    Object.hasOwn(reasons, agent) ? reasons[agent] : null;
  return rows
    .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
    .map((row): AgentRow => ({ ...row, reason: reasonOf(row.key) }));
}

export function descendants(
  id: string,
  children: Map<string, string[]>,
): string[] {
  const found = new Set<string>();
  const pending = [id];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return [...found];
}

export function buildSessions(view: View): SessionRow[] {
  const { sessionFacts, attribution } = view.model;
  const children = new Map<string, string[]>();
  for (const [id, fact] of sessionFacts)
    if (fact.parent)
      children.set(fact.parent, [...(children.get(fact.parent) ?? []), id]);
  const key = (item: Item) => (item.session_id ? [item.session_id] : []);
  const current = group(view.items, key);
  const previous = view.previousItems && group(view.previousItems, key);
  const rolled = (groups: Map<string, Item[]>, id: string) =>
    descendants(id, children).flatMap((member) => groups.get(member) ?? []);
  const iso = (ms: number | null) =>
    ms === null ? null : new Date(ms).toISOString();
  return [...current]
    .map(([id, items]): SessionRow => {
      const fact = sessionFacts.get(id)!;
      const own = view.stats(items, previous ? (previous.get(id) ?? []) : null);
      const issues = new Set(
        items.flatMap(
          (item) => attribution.attributions.get(item.id)?.issue_ids ?? [],
        ),
      );
      return {
        key: id,
        label: fact.name ?? id,
        ...own,
        rolled_up: view.stats(
          rolled(current, id),
          previous && rolled(previous, id),
        ),
        agent: fact.agent,
        name: fact.name,
        model: fact.model,
        parent_session_id: fact.parent,
        children: [...(children.get(id) ?? [])].sort(),
        start: iso(fact.start),
        end: iso(fact.end),
        duration_ms:
          fact.start !== null && fact.end !== null
            ? fact.end - fact.start
            : null,
        issues: [...issues].sort(),
      };
    })
    .sort(
      (a, b) =>
        (b.start ?? '').localeCompare(a.start ?? '') ||
        a.key.localeCompare(b.key),
    );
}

export function buildIssues(view: View): {
  issues: IssueRow[];
  unattributed: Row;
} {
  const { attribution, rolledIssues } = view.model;
  const own = (item: Item) =>
    attribution.attributions.get(item.id)?.issue_ids ?? [];
  const rolledOf = (item: Item) => [...(rolledIssues.get(item.id) ?? [])];
  const previousOwn = view.previousItems && group(view.previousItems, own);
  const previousRolled =
    view.previousItems && group(view.previousItems, rolledOf);
  const currentOwn = group(view.items, own);
  const currentRolled = group(view.items, rolledOf);
  const issues = [...currentRolled].map(([id, rolledItems]): IssueRow => {
    const facts = attribution.issues.get(id);
    return {
      key: id,
      label: facts?.title ?? id,
      ...view.stats(
        currentOwn.get(id) ?? [],
        previousOwn && (previousOwn.get(id) ?? []),
      ),
      rolled_up: view.stats(
        rolledItems,
        previousRolled && (previousRolled.get(id) ?? []),
      ),
      status: facts?.status ?? 'unknown',
      issue_type: facts?.issue_type ?? 'unknown',
      parent: facts?.parent ?? null,
    };
  });
  issues.sort(
    (a, b) =>
      b.rolled_up.totals.commands - a.rolled_up.totals.commands ||
      a.key.localeCompare(b.key),
  );
  const unattributed = (item: Item) => (own(item).length === 0 ? [item] : []);
  return {
    issues,
    unattributed: {
      key: 'unattributed',
      label: 'Unattributed',
      ...view.stats(
        view.items.flatMap(unattributed),
        view.previousItems && view.previousItems.flatMap(unattributed),
      ),
    },
  };
}

export function buildQueries(view: View): QueryRow[] {
  const { sequence } = view.model;
  const queryOf = (item: Item) =>
    isSearch(item) && item.usage?.query != null
      ? [normalizeQuery(item.usage.query)]
      : [];
  return view
    .entries(queryOf, (key) => key)
    .map(({ row, items: searches }): QueryRow => {
      const events = searches.map((item) => item.usage!);
      const known = events.filter((e) => e.result_count !== null);
      const returned = new Map<string, { returned: number; opened: number }>();
      const entry = (sectionId: string) => {
        let count = returned.get(sectionId);
        if (!count)
          returned.set(sectionId, (count = { returned: 0, opened: 0 }));
        return count;
      };
      const ranks: number[] = [];
      for (const [index, search] of searches.entries()) {
        for (const sectionId of events[index].result_ids)
          entry(sectionId).returned++;
        for (const opened of sequence.readsBySearch.get(search.id) ?? []) {
          entry(opened.sectionId).opened++;
          ranks.push(opened.rank);
        }
      }
      return {
        ...row,
        count: searches.length,
        sessions: new Set(searches.map((s) => s.session_id).filter(Boolean))
          .size,
        result_count: median(known.map((e) => e.result_count!)),
        empty_share: ratio(
          known.filter((e) => e.result_count === 0).length,
          known.length,
        ),
        follow_through_share: ratio(
          searches.filter((s) => sequence.followed.has(s.id)).length,
          searches.length,
        ),
        median_rank_opened: median(ranks),
        sections_returned: [...returned]
          .map(([section_id, counts]) => ({ section_id, ...counts }))
          .sort(
            (a, b) =>
              b.returned - a.returned ||
              b.opened - a.opened ||
              a.section_id.localeCompare(b.section_id),
          ),
        reformulations: searches.filter((s) => sequence.reformulated.has(s.id))
          .length,
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function buildSections(view: View): SectionRow[] {
  const { sequence, rolledIssues, items: allItems } = view.model;
  const queryByEvent = new Map(
    allItems.map((item) => [item.id, item.usage?.query ?? null] as const),
  );
  const reads = readsByKey(view, sectionOf);
  const previous =
    view.previousItems &&
    group(view.previousItems.filter(isSectionRead), (item) => [
      sectionOf(item)!,
    ]);
  return [...reads]
    .map(([sectionId, items]): SectionRow => {
      const queries = new Map<string, number>();
      const readsPerDay = new Map<string, number>();
      for (const item of items) {
        readsPerDay.set(item.day, (readsPerDay.get(item.day) ?? 0) + 1);
        const searchId = sequence.reads.get(item.id)?.searchId;
        const query = searchId ? queryByEvent.get(searchId) : null;
        if (query != null)
          queries.set(
            normalizeQuery(query),
            (queries.get(normalizeQuery(query)) ?? 0) + 1,
          );
      }
      return {
        key: sectionId,
        label: sectionId,
        ...view.stats(items, previous ? (previous.get(sectionId) ?? []) : null),
        document: documentOf(sectionId),
        reads: items.length,
        reads_by_day: view.context.days.map((day) => ({
          day,
          reads: readsPerDay.get(day) ?? 0,
        })),
        queries: [...queries]
          .map(([query, count]) => ({ query, count }))
          .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query)),
        issues: [
          ...new Set(
            items.flatMap((item) => [...(rolledIssues.get(item.id) ?? [])]),
          ),
        ].sort(),
      };
    })
    .sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key));
}

export function buildDocuments(view: View): DocumentRow[] {
  const documentKey = (item: Item) => {
    const section = sectionOf(item);
    return isSectionRead(item) && section ? [documentOf(section)] : [];
  };
  return view
    .entries(documentKey, (key) => key)
    .map(
      ({ row, items }): DocumentRow => ({
        ...row,
        reads: row.totals.section_reads,
        sections_read: new Set(items.map(sectionOf)).size,
      }),
    )
    .sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key));
}
