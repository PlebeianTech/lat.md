import { useMemo, type MouseEvent, type ReactNode } from 'react';
import type {
  SectionRow,
  UsageOverview,
} from '../../../../src/fork/usage/aggregate-types';
import type { KnowledgeBreakdown } from '../../../../src/fork/usage/graph-snapshot';
import type {
  ScorecardRow,
  SectionScorecard,
} from '../../../../src/fork/usage/section-scorecard';
import { BarList } from '../charts/bar-list';
import { Sparkline } from '../charts/sparkline';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';
import { KnowledgeMap } from './knowledge-map';

const WRAP = { overflowWrap: 'anywhere' } as const;
const TOP_SECTIONS = 20;

const count = (value: number) => value.toLocaleString('en-US');

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

const sectionPath = (sectionId: string, search: string) =>
  `/_usage/knowledge/${encodeURIComponent(sectionId)}${search}`;

type Extension<T> = { value: T } | { unknown: string };

/** An extension that is missing or holds `{ error }` is unknown with its reason. */
function extensionOf<T>(raw: unknown, name: string): Extension<T> {
  if (raw === undefined || raw === null)
    return { unknown: `the ${name} is missing from the summary` };
  const failure = (raw as { error?: unknown }).error;
  if (typeof failure === 'string') return { unknown: failure };
  return { value: raw as T };
}

function UnavailableHeads({
  heads,
}: {
  heads: { git_head: string; reason: string }[];
}) {
  if (heads.length === 0) return null;
  return (
    <p role="note" style={WRAP}>
      Snapshots unavailable for {count(heads.length)} git{' '}
      {heads.length === 1 ? 'head' : 'heads'}:{' '}
      {heads.map((h) => `${h.git_head.slice(0, 7)} (${h.reason})`).join(', ')}
    </p>
  );
}

const Unknown = ({ reason }: { reason: string }) => <p>unknown ({reason})</p>;

function NeverRead({
  knowledge,
  search,
}: {
  knowledge: Extension<KnowledgeBreakdown>;
  search: string;
}) {
  if ('unknown' in knowledge) return <Unknown reason={knowledge.unknown} />;
  const { snapshot, snapshot_reason, never_read_sections } = knowledge.value;
  if (snapshot === null)
    return (
      <Unknown
        reason={
          snapshot_reason ?? 'no git head with a graph snapshot in this range'
        }
      />
    );
  if (never_read_sections.length === 0) return <p>0 never-read sections.</p>;
  return (
    <details>
      <summary>
        {count(never_read_sections.length)} never-read{' '}
        {never_read_sections.length === 1 ? 'section' : 'sections'}
      </summary>
      <ul aria-label="Never-read sections">
        {never_read_sections.map((section) => (
          <li key={section.id} style={WRAP}>
            <Link to={sectionPath(section.id, search)}>{section.id}</Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function KnowledgeOverview({
  summary,
  search,
}: {
  summary: UsageOverview;
  search: string;
}) {
  const knowledge = extensionOf<KnowledgeBreakdown>(
    summary.extensions?.knowledge,
    'knowledge extension',
  );
  const top = useMemo(
    () =>
      [...summary.sections]
        .sort((a, b) => b.reads - a.reads)
        .slice(0, TOP_SECTIONS),
    [summary.sections],
  );
  return (
    <>
      <h1>Knowledge</h1>
      <h2>Most-read sections</h2>
      {top.length === 0 ? (
        <p>No section reads under the current filters.</p>
      ) : (
        <>
          <BarList
            label="Most-read sections"
            limit={TOP_SECTIONS}
            items={top.map((s) => ({ label: s.key, value: s.reads }))}
          />
          <ol aria-label="Most-read section links">
            {top.map((s) => (
              <li key={s.key} style={WRAP}>
                <Link to={sectionPath(s.key, search)}>{s.key}</Link>
              </li>
            ))}
          </ol>
        </>
      )}
      {'value' in knowledge && (
        <UnavailableHeads heads={knowledge.value.unavailable_heads ?? []} />
      )}
      <h2>Never-read sections</h2>
      <NeverRead knowledge={knowledge} search={search} />
      <h2>Knowledge map</h2>
      {'unknown' in knowledge ? (
        <Unknown reason={knowledge.unknown} />
      ) : knowledge.value.snapshot === null ? (
        <Unknown
          reason={
            knowledge.value.snapshot_reason ??
            'no git head with a graph snapshot in this range'
          }
        />
      ) : (
        <KnowledgeMap documents={knowledge.value.documents} />
      )}
    </>
  );
}

function Reach({
  scorecard,
  sectionId,
  search,
}: {
  scorecard: Extension<SectionScorecard>;
  sectionId: string;
  search: string;
}) {
  if ('unknown' in scorecard) return <Unknown reason={scorecard.unknown} />;
  const row: ScorecardRow | undefined = scorecard.value.sections.find(
    (s) => s.section_id === sectionId,
  );
  const unavailable = (
    <UnavailableHeads heads={scorecard.value.unavailable_heads ?? []} />
  );
  if (!row)
    return (
      <>
        {unavailable}
        <Unknown reason="the section scorecard has no row for this section" />
      </>
    );
  return (
    <>
      {unavailable}
      <Sparkline
        label={`Reach per day: ${sectionId}`}
        points={row.daily.map((d) => ({ day: d.day, value: d.reach }))}
      />
      <p>
        Reached in {count(row.reached)} of {count(row.expected)} times expected.
      </p>
      {row.renamed_from !== null && (
        <p style={WRAP}>
          Renamed from{' '}
          <Link to={sectionPath(row.renamed_from, search)}>
            {row.renamed_from}
          </Link>
          .
        </p>
      )}
      {row.ends_at_head !== null && (
        <p style={WRAP}>This id ends at head {row.ends_at_head.slice(0, 7)}.</p>
      )}
      {row.change_markers.length === 0 ? (
        <p>No content changes in the range.</p>
      ) : (
        <ul aria-label="Content changes">
          {row.change_markers.map((marker) => (
            <li key={marker.git_head}>
              {marker.day}: content changed at head{' '}
              {marker.git_head.slice(0, 7)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SectionDetail({
  id,
  row,
  scorecard,
  search,
}: {
  id: string;
  row: SectionRow | undefined;
  scorecard: Extension<SectionScorecard>;
  search: string;
}) {
  return (
    <section>
      <p>
        <Link to={`/_usage/knowledge${search}`}>Knowledge</Link>
      </p>
      <h1 style={WRAP}>{id}</h1>
      <h2>Reads over time</h2>
      {row ? (
        <>
          <p>
            {count(row.reads)} reads in {row.document}.
          </p>
          <Sparkline
            label={`Reads per day: ${id}`}
            points={row.reads_by_day.map((d) => ({
              day: d.day,
              value: d.reads,
            }))}
          />
        </>
      ) : (
        <p>This section has no reads under the current filters.</p>
      )}
      <h2>Reach over time</h2>
      <Reach scorecard={scorecard} sectionId={id} search={search} />
      {row && (
        <>
          <h2>Queries that led to a read</h2>
          {row.queries.length === 0 ? (
            <p>No search led to a read of this section.</p>
          ) : (
            <ul aria-label="Leading queries">
              {row.queries.map((q) => (
                <li key={q.query} style={WRAP}>
                  <Link
                    to={`/_usage/queries/${encodeURIComponent(q.query)}${search}`}
                  >
                    {q.query}
                  </Link>{' '}
                  ({count(q.count)})
                </li>
              ))}
            </ul>
          )}
          <h2>Issues that read it</h2>
          {row.issues.length === 0 ? (
            <p>No issue is linked to a read of this section.</p>
          ) : (
            <ul aria-label="Reading issues">
              {row.issues.map((issue) => (
                <li key={issue} style={WRAP}>
                  <Link
                    to={`/_usage/issues/${encodeURIComponent(issue)}${search}`}
                  >
                    {issue}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function KnowledgePage({ id }: UsagePageProps) {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<UsageOverview>('/api/usage');
  return (
    <section>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && (
        <p style={WRAP}>
          Loading Knowledge{id === undefined ? '' : `: ${id}`}…
        </p>
      )}
      {data && id !== undefined && (
        <SectionDetail
          id={id}
          row={data.sections.find((s) => s.key === id)}
          scorecard={extensionOf<SectionScorecard>(
            data.extensions?.section_scorecard,
            'section scorecard',
          )}
          search={search}
        />
      )}
      {data && id === undefined && (
        <KnowledgeOverview summary={data} search={search} />
      )}
    </section>
  );
}
