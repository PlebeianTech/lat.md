import {
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { RawEventsPage } from '../../../../src/fork/usage/event-index';
import type {
  Finding,
  FindingsResult,
} from '../../../../src/fork/usage/findings';
import { shorten } from '../charts/chart-parts';
import { EntityTable } from '../entity-table';
import { filtersToSearchParams, navigateTo, useUsageFilters } from '../filters';
import type { UsagePageProps } from '../routes';
import { useUsageData } from '../use-usage-data';

const KIND_GUIDANCE: Record<string, { means: string; action: string }> = {
  'empty-search': {
    means:
      'The query an agent searched for returned nothing, so the knowledge graph did not answer it.',
    action:
      'Add or reword a section so this query finds it, starting with the closest section suggested here.',
  },
  'bypassed-file': {
    means:
      'Agents read this file under lat.md/ directly instead of through lat.',
    action:
      'Make its sections easy to reach through lat search, or split the file if it is too large to read through lat.',
  },
  'never-read-section': {
    means: 'No agent has read this section in the selected period.',
    action:
      'Check that the section is findable, or merge or remove it if nothing needs it.',
  },
  'stale-hot-section': {
    means:
      'One of the 20 most-read sections references code that changed after the section last did.',
    action: 'Review the section against the code and update it.',
  },
  'uncovered-hot-file': {
    means:
      'Agents edited a file with no documentation in at least three sessions.',
    action: 'Write a section for it, and reference the file from the section.',
  },
  'search-miss': {
    means:
      'Agents searched, did not find a section they went on to need, and edited the code without it.',
    action: 'Reword the expected section so the query finds it.',
  },
};
const GENERIC_GUIDANCE = {
  means: 'This kind of finding has no description in the dashboard yet.',
  action: 'Open the evidence events to see what happened.',
};

// @lat: [[usage-dashboard#Usage Dashboard#Findings]]
function fromSections(finding: Finding): boolean {
  return (
    finding.kind === 'stale-hot-section' ||
    finding.kind === 'never-read-section'
  );
}

function formatTime(value: string | null): string | null {
  return value === null ? null : value.replace('T', ' ').slice(0, 16);
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
    <a href={to} onClick={follow}>
      {children}
    </a>
  );
}

function FailedDetectors({ errors }: { errors: FindingsResult['errors'] }) {
  if (errors.length === 0) return null;
  return (
    <div role="alert">
      <p>
        {errors.length === 1 ? 'A detector' : `${errors.length} detectors`}{' '}
        failed, so the findings may be incomplete.
      </p>
      <ul>
        {errors.map((error) => (
          <li key={error.detector}>
            <strong>{error.detector}</strong>: {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceList({
  finding,
  search,
}: {
  finding: Finding;
  search: string;
}) {
  const raw = useUsageData<RawEventsPage>('/api/usage/raw', {
    ids: finding.evidence.join(','),
  });
  const byId = new Map((raw.data?.records ?? []).map((r) => [r.id, r]));
  return (
    <section>
      <h2>Evidence</h2>
      {raw.error && <p role="alert">{raw.error.message}</p>}
      {raw.loading && !raw.data && <p>Loading events…</p>}
      <ul>
        {finding.evidence.map((eventId) => {
          const record = byId.get(eventId);
          const explore = new URLSearchParams(search.slice(1));
          explore.set('event', eventId);
          return (
            <li key={eventId}>
              <Link to={`/_usage/explore?${explore.toString()}`}>
                <code>{shorten(eventId, 24)}</code>
              </Link>
              {record ? (
                <>
                  {' '}
                  {formatTime(record.ts)}
                  {record.session_id && (
                    <>
                      {' '}
                      session{' '}
                      <Link
                        to={`/_usage/sessions/${encodeURIComponent(record.session_id)}${search}`}
                      >
                        {shorten(record.session_id, 16)}
                      </Link>
                    </>
                  )}
                  {record.issue_ids.map((issue) => (
                    <span key={issue}>
                      {' '}
                      issue{' '}
                      <Link
                        to={`/_usage/issues/${encodeURIComponent(issue)}${search}`}
                      >
                        {issue}
                      </Link>
                    </span>
                  ))}
                </>
              ) : (
                !raw.loading && ' (not found under the current filters)'
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function noEvidenceText(kind: string): string {
  if (kind === 'never-read-section')
    return 'This finding has no events: nothing read the section.';
  if (kind === 'stale-hot-section')
    return "This finding has no events of its own: its count is the section's reads.";
  return 'This finding has no events.';
}

function FindingDetail({
  finding,
  search,
}: {
  finding: Finding;
  search: string;
}) {
  const guidance = KIND_GUIDANCE[finding.kind] ?? GENERIC_GUIDANCE;
  return (
    <section>
      <p>
        <Link to={`/_usage/findings${search}`}>All findings</Link>
      </p>
      <h1>{finding.subject}</h1>
      {finding.kind === 'stale-hot-section' ? (
        <p>
          {finding.kind}: the section was read{' '}
          {finding.count.toLocaleString('en-US')} times.
        </p>
      ) : finding.kind === 'never-read-section' ? (
        <p>
          {finding.kind}: no agent read this section in the selected period.
        </p>
      ) : (
        <p>
          {finding.kind}: {finding.count.toLocaleString('en-US')} events in{' '}
          {finding.sessions.toLocaleString('en-US')} sessions, first seen{' '}
          {formatTime(finding.first_seen) ?? 'unknown'}, last seen{' '}
          {formatTime(finding.last_seen) ?? 'unknown'}.
        </p>
      )}
      <h2>What it means</h2>
      <p>{guidance.means}</p>
      <h2>What to do</h2>
      <p>{guidance.action}</p>
      {finding.suggestion && (
        <p>
          Closest section: <code>{finding.suggestion.section_id}</code> (
          {finding.suggestion.title}).
        </p>
      )}
      {finding.expected_section_id && (
        <p>
          Expected section:{' '}
          <Link
            to={`/_usage/knowledge/${encodeURIComponent(finding.expected_section_id)}${search}`}
          >
            {finding.expected_section_id}
          </Link>
        </p>
      )}
      {finding.evidence.length > 0 ? (
        // An empty id list means no filter to the server, so never send one.
        <EvidenceList finding={finding} search={search} />
      ) : (
        <section>
          <h2>Evidence</h2>
          <p>{noEvidenceText(finding.kind)}</p>
        </section>
      )}
    </section>
  );
}

function FindingsList({
  findings,
  search,
}: {
  findings: Finding[];
  search: string;
}) {
  const { filters } = useUsageFilters();
  const [kind, setKind] = useState('');
  const kinds = [...new Set(findings.map((finding) => finding.kind))].sort();
  const shown = kind
    ? findings.filter((finding) => finding.kind === kind)
    : findings;
  return (
    <div>
      <label>
        Kind{' '}
        <select
          aria-label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">All kinds</option>
          {kinds.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <EntityTable<Finding>
        label="Findings"
        columns={[
          { key: 'subject', header: 'Subject', value: (f) => f.subject },
          { key: 'kind', header: 'Kind', value: (f) => f.kind },
          {
            key: 'count',
            header: 'Count',
            value: (f) => f.count,
            numeric: true,
          },
          {
            key: 'sessions',
            header: 'Sessions',
            value: (f) => (fromSections(f) ? null : f.sessions),
            unknownText: '—',
            numeric: true,
          },
          {
            key: 'first',
            header: 'First seen',
            value: (f) => (fromSections(f) ? '—' : formatTime(f.first_seen)),
          },
          {
            key: 'last',
            header: 'Last seen',
            value: (f) => (fromSections(f) ? '—' : formatTime(f.last_seen)),
          },
        ]}
        rows={shown}
        rowKey={(f) => f.id}
        href={(f) => `/_usage/findings/${encodeURIComponent(f.id)}${search}`}
        trend={{
          header: 'Daily',
          points: (f) =>
            fromSections(f)
              ? []
              : f.daily.map((d) => ({ day: d.day, value: d.count })),
        }}
        activeFilters={[
          ...Object.entries(filters).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          ...(kind ? [`kind: ${kind}`] : []),
        ]}
        defaultSort={{ key: 'count', direction: 'descending' }}
      />
    </div>
  );
}

export function FindingsPage({ id }: UsagePageProps) {
  const search = useFilterSearch();
  const { data, error, loading } = useUsageData<FindingsResult>(
    '/api/usage/findings',
  );
  const finding =
    id === undefined ? undefined : data?.findings.find((f) => f.id === id);
  return (
    <section>
      {error && <p role="alert">{error.message}</p>}
      {loading && !data && <p>Loading findings…</p>}
      {data && <FailedDetectors errors={data.errors} />}
      {data && id !== undefined && !finding && (
        <>
          <h1>Finding</h1>
          <p>
            This finding no longer applies under the current filters.{' '}
            <Link to={`/_usage/findings${search}`}>All findings</Link>
          </p>
        </>
      )}
      {finding && <FindingDetail finding={finding} search={search} />}
      {data && id === undefined && (
        <>
          <h1>Findings</h1>
          {data.findings.length === 0 && data.errors.length === 0 ? (
            <p>No findings under the current filters.</p>
          ) : (
            <FindingsList findings={data.findings} search={search} />
          )}
        </>
      )}
    </section>
  );
}
