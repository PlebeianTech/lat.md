// @lat: [[usage-section-scorecard#Usage Section Scorecard]]
import {
  dayOf,
  ratio,
  type AggregateContext,
  type Contribution,
} from './aggregate-types.js';
import { snapshotAt, type SnapshotResult } from './graph-snapshot.js';
import {
  OUTCOMES,
  missedKnowledgeContribution,
  type MissedKnowledge,
  type Outcome,
  type OutcomeRecord,
} from './missed-knowledge.js';

type Miss = Exclude<Outcome, 'reached'>;

export const SUGGESTED_FIXES: Record<Miss, string> = {
  'searched-not-found':
    'reword the section title and leading paragraph to match the words agents search with.',
  'found-not-opened':
    'improve the leading paragraph, which is the search preview.',
  'never-consulted':
    'link it from the code it describes with @lat comments, or make the prompt hook surface it.',
  bypassed: 'split the file; the section is hard to reach through lat.',
  'read-late':
    'a workflow problem, not a documentation problem; review agent instructions.',
};

export interface ScorecardHead {
  git_head: string;
  first_ts: number;
  result: SnapshotResult;
}

export interface ChangeMarker {
  git_head: string;
  day: string;
}

export interface DailySectionReach {
  day: string;
  expected: number;
  reached: number;
  reach: number | null;
}

export interface ScorecardRow {
  section_id: string;
  expected: number;
  reached: number;
  reach: number | null;
  outcomes: Record<Outcome, number>;
  main_miss: Miss | null;
  suggested_fix: string | null;
  daily: DailySectionReach[];
  change_markers: ChangeMarker[];
  renamed_from: string | null;
  ends_at_head: string | null;
}

export interface SectionScorecard {
  sections: ScorecardRow[];
  unavailable_heads: { git_head: string; reason: string }[];
}

const emptyOutcomes = () =>
  Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    Outcome,
    number
  >;

function mainMiss(outcomes: Record<Outcome, number>): Miss | null {
  let best: Miss | null = null;
  for (const outcome of OUTCOMES) {
    if (outcome === 'reached' || outcomes[outcome] === 0) continue;
    if (best === null || outcomes[outcome] > outcomes[best]) best = outcome;
  }
  return best;
}

interface HeadHistory {
  markers: Map<string, ChangeMarker[]>;
  renamedFrom: Map<string, string>;
  endsAtHead: Map<string, string>;
}

interface SectionsAtHead {
  head: string;
  sections: Map<string, { document: string; hash: string }>;
}

function detectRenames(
  previous: SectionsAtHead,
  sections: SectionsAtHead['sections'],
  history: HeadHistory,
): void {
  const gone = [...previous.sections.keys()]
    .filter((id) => !sections.has(id))
    .sort();
  const added = [...sections.keys()]
    .filter((id) => !previous.sections.has(id))
    .sort();
  const claimed = new Set<string>();
  for (const id of added) {
    const now = sections.get(id)!;
    const old = gone.find((oldId) => {
      const before = previous.sections.get(oldId)!;
      return (
        !claimed.has(oldId) &&
        before.document === now.document &&
        before.hash === now.hash
      );
    });
    if (old === undefined) continue;
    claimed.add(old);
    history.renamedFrom.set(id, old);
    history.endsAtHead.set(old, previous.head);
  }
}

function readHistory(ordered: ScorecardHead[]): HeadHistory {
  const history: HeadHistory = {
    markers: new Map(),
    renamedFrom: new Map(),
    endsAtHead: new Map(),
  };
  const lastHash = new Map<string, string>();
  let previous: SectionsAtHead | null = null;
  for (const head of ordered) {
    if (head.result.snapshot === null) continue;
    const sections = new Map(
      head.result.snapshot.sections.map((s) => [s.id, s]),
    );
    if (previous) detectRenames(previous, sections, history);
    for (const [id, section] of sections) {
      const before = lastHash.get(id);
      if (before !== undefined && before !== section.hash) {
        const markers = history.markers.get(id) ?? [];
        markers.push({ git_head: head.git_head, day: dayOf(head.first_ts) });
        history.markers.set(id, markers);
      }
      lastHash.set(id, section.hash);
    }
    previous = { head: head.git_head, sections };
  }
  return history;
}

function rowFor(
  sectionId: string,
  records: OutcomeRecord[],
  days: string[],
  history: HeadHistory,
): ScorecardRow {
  const outcomes = emptyOutcomes();
  const perDay = new Map<string, { expected: number; reached: number }>();
  for (const record of records) {
    outcomes[record.outcome]++;
    if (record.session_start === null) continue;
    const day = dayOf(Date.parse(record.session_start));
    const point = perDay.get(day) ?? { expected: 0, reached: 0 };
    point.expected++;
    if (record.outcome === 'reached') point.reached++;
    perDay.set(day, point);
  }
  const miss = mainMiss(outcomes);
  return {
    section_id: sectionId,
    expected: records.length,
    reached: outcomes.reached,
    reach: ratio(outcomes.reached, records.length),
    outcomes,
    main_miss: miss,
    suggested_fix: miss === null ? null : SUGGESTED_FIXES[miss],
    daily: days.map((day) => {
      const { expected, reached } = perDay.get(day) ?? {
        expected: 0,
        reached: 0,
      };
      return { day, expected, reached, reach: ratio(reached, expected) };
    }),
    change_markers: history.markers.get(sectionId) ?? [],
    renamed_from: history.renamedFrom.get(sectionId) ?? null,
    ends_at_head: history.endsAtHead.get(sectionId) ?? null,
  };
}

export function buildScorecard(
  records: OutcomeRecord[],
  heads: ScorecardHead[],
  days: string[],
): SectionScorecard {
  const ordered = [...heads].sort(
    (a, b) => a.first_ts - b.first_ts || a.git_head.localeCompare(b.git_head),
  );
  const history = readHistory(ordered);
  const bySection = new Map<string, OutcomeRecord[]>();
  for (const record of records) {
    const own = bySection.get(record.section_id) ?? [];
    own.push(record);
    bySection.set(record.section_id, own);
  }
  const sections = [...bySection]
    .map(([id, own]) => rowFor(id, own, days, history))
    .sort(
      (a, b) =>
        (a.reach ?? Infinity) - (b.reach ?? Infinity) ||
        b.expected - a.expected ||
        a.section_id.localeCompare(b.section_id),
    );
  return {
    sections,
    unavailable_heads: ordered.flatMap((head) =>
      head.result.snapshot === null
        ? [{ git_head: head.git_head, reason: head.result.reason }]
        : [],
    ),
  };
}

function rangeHeads(context: AggregateContext) {
  const heads = new Map<string, { first_ts: number; worktrees: string[] }>();
  for (const item of context.items) {
    const head = item.usage?.git_head;
    if (!head) continue;
    const known = heads.get(head) ?? { first_ts: item.ts, worktrees: [] };
    known.first_ts = Math.min(known.first_ts, item.ts);
    const worktree = item.usage?.worktree;
    if (worktree && !known.worktrees.includes(worktree))
      known.worktrees.push(worktree);
    heads.set(head, known);
  }
  return heads;
}

export const sectionScorecardContribution: Contribution = {
  key: 'section_scorecard',
  async prepare(context) {
    await missedKnowledgeContribution.prepare?.(context);
  },
  async compute(context): Promise<SectionScorecard> {
    const missed = (await missedKnowledgeContribution.compute(
      context,
    )) as MissedKnowledge;
    const heads: ScorecardHead[] = [];
    for (const [git_head, { first_ts, worktrees }] of rangeHeads(context))
      heads.push({
        git_head,
        first_ts,
        result: await snapshotAt(context.root, git_head, worktrees),
      });
    return buildScorecard(missed.records, heads, context.days);
  },
};
