// @lat: [[usage-findings#Usage Findings#Extra detectors plug in]]
import { dayOf, normalizeQuery, type UsageSummary } from './aggregate-types.js';
import {
  MAX_PAGE_SIZE,
  queryUsageEvents,
  type RawRecord,
  type EventIndexOptions,
} from './event-index.js';
import type { Aggregator } from './aggregate-types.js';
import { filtersKey, type UsageFilters } from './filters.js';
import type { UsageRouteContext } from './live.js';
import { staleHotSectionDetector } from './findings-stale-sections.js';
import { utilizationDetector } from './findings-utilization.js';
import { USAGE_SCHEMA_VERSION } from './schema.js';

export const MAX_EVIDENCE = 50;

export interface FindingSuggestion {
  section_id: string;
  title: string;
  similarity: number;
}

export interface Finding {
  kind: string;
  id: string;
  subject: string;
  count: number;
  sessions: number;
  first_seen: string | null;
  last_seen: string | null;
  daily: { day: string; count: number }[];
  evidence: string[];
  suggestion: FindingSuggestion | null;
  /** search-miss only: the section the query should have matched. */
  expected_section_id?: string;
}

export interface FindingsInput {
  summary: UsageSummary;
  records: RawRecord[];
}

export interface FindingDetector {
  name: string;
  prepare?(context: { root: string }): Promise<void>;
  detect(input: FindingsInput): Finding[];
}

export interface FindingsResult {
  findings: Finding[];
  errors: { detector: string; message: string }[];
}

export function groupedFinding(
  kind: string,
  subject: string,
  records: RawRecord[],
  days: string[],
  suggestion: FindingSuggestion | null = null,
): Finding {
  const perDay = new Map<string, number>();
  const sessions = new Set<string>();
  for (const record of records) {
    const day = dayOf(Date.parse(record.ts));
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (record.session_id) sessions.add(record.session_id);
  }
  const times = records.map((record) => Date.parse(record.ts));
  return {
    kind,
    id: `${kind}:${subject}`,
    subject,
    count: records.length,
    sessions: sessions.size,
    first_seen: records.length
      ? new Date(Math.min(...times)).toISOString()
      : null,
    last_seen: records.length
      ? new Date(Math.max(...times)).toISOString()
      : null,
    daily: days.map((day) => ({ day, count: perDay.get(day) ?? 0 })),
    evidence: [...records]
      .sort(
        (a, b) => Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : -1),
      )
      .slice(0, MAX_EVIDENCE)
      .map((record) => record.id),
    suggestion,
  };
}

function bySubject(
  records: RawRecord[],
  subjectOf: (record: RawRecord) => string | null,
): Map<string, RawRecord[]> {
  const groups = new Map<string, RawRecord[]>();
  for (const record of records) {
    const subject = subjectOf(record);
    if (!subject) continue;
    const members = groups.get(subject);
    if (members) members.push(record);
    else groups.set(subject, [record]);
  }
  return groups;
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

const titleOf = (sectionId: string) => sectionId.split('#').pop() ?? sectionId;

function closestSection(
  query: string,
  summary: UsageSummary,
): FindingSuggestion | null {
  const ids = new Set(summary.sections.map((section) => section.key));
  const knowledge = summary.extensions.knowledge as
    | { snapshot?: { sections?: { id: string }[] } | null }
    | undefined;
  for (const section of knowledge?.snapshot?.sections ?? [])
    ids.add(section.id);
  const wanted = words(query);
  let best: FindingSuggestion | null = null;
  for (const id of [...ids].sort()) {
    const title = titleOf(id);
    const own = words(title);
    const shared = [...own].filter((word) => wanted.has(word)).length;
    const similarity = shared / (own.size + wanted.size - shared || 1);
    if (shared > 0 && (best === null || similarity > best.similarity))
      best = { section_id: id, title, similarity };
  }
  return best;
}

export const emptySearchDetector: FindingDetector = {
  name: 'empty-search',
  detect({ summary, records }) {
    const groups = bySubject(records, (record) =>
      record.type === 'usage' &&
      record.event.command === 'search' &&
      record.event.result_count === 0 &&
      record.event.query
        ? normalizeQuery(record.event.query)
        : null,
    );
    return [...groups].map(([query, members]) =>
      groupedFinding(
        'empty-search',
        query,
        members,
        summary.days,
        closestSection(query, summary),
      ),
    );
  },
};

export const bypassedFileDetector: FindingDetector = {
  name: 'bypassed-file',
  detect({ summary, records }) {
    const groups = bySubject(records, (record) =>
      record.type === 'session' && record.event.kind === 'bypass_read'
        ? record.event.path
        : null,
    );
    return [...groups].map(([path, members]) =>
      groupedFinding('bypassed-file', path, members, summary.days),
    );
  },
};

export const neverReadSectionDetector: FindingDetector = {
  name: 'never-read-section',
  detect({ summary }) {
    const knowledge = summary.extensions.knowledge as
      | { never_read_sections?: { id: string }[] }
      | undefined;
    const sections = Array.isArray(knowledge?.never_read_sections)
      ? knowledge.never_read_sections
      : [];
    return sections.map((section) => ({
      ...groupedFinding('never-read-section', section.id, [], summary.days),
      count: 1,
    }));
  },
};

function compareFindings(a: Finding, b: Finding): number {
  return (
    b.sessions - a.sessions ||
    b.count - a.count ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function computeFindings(
  input: FindingsInput,
  skip: ReadonlySet<string> = new Set(),
): FindingsResult {
  const findings: Finding[] = [];
  const errors: FindingsResult['errors'] = [];
  for (const detector of findingDetectors)
    if (!skip.has(detector.name))
      try {
        findings.push(...detector.detect(input));
      } catch (error) {
        errors.push({
          detector: detector.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
  return { findings: findings.sort(compareFindings), errors };
}

// @lat: [[usage-findings#Usage Findings#Findings are memoized per data version]]
export function findingsFor(
  aggregator: Aggregator,
  filters: UsageFilters,
  index: EventIndexOptions,
) {
  const day = new Date().toISOString().slice(0, 10);
  return aggregator.memo(`findings\0${day}\0${filtersKey(filters)}`, () =>
    computeFindingsFor(aggregator, filters, index),
  );
}

async function computeFindingsFor(
  aggregator: Aggregator,
  filters: UsageFilters,
  index: EventIndexOptions,
) {
  const failed = new Set<string>();
  const prepareErrors: FindingsResult['errors'] = [];
  await Promise.all(
    findingDetectors.map(async (detector) => {
      try {
        await detector.prepare?.({ root: index.root });
      } catch (error) {
        failed.add(detector.name);
        prepareErrors.push({
          detector: detector.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  const records: RawRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryUsageEvents(filters, {
      ...index,
      cursor,
      limit: MAX_PAGE_SIZE,
    });
    records.push(...page.records);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  const summary = await aggregator.summary(filters);
  const result = computeFindings({ summary, records }, failed);
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    findings: result.findings,
    errors: [...prepareErrors, ...result.errors],
  };
}

export const findingsRoute = ({
  root,
  filters,
  aggregator,
}: UsageRouteContext) => findingsFor(aggregator, filters, { root });

// prettier-ignore
export const findingDetectors: FindingDetector[] = [
  emptySearchDetector,
  bypassedFileDetector,
  neverReadSectionDetector,
  staleHotSectionDetector,
  utilizationDetector,
];
