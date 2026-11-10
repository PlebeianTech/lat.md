// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finding, FindingsResult } from '../src/fork/usage/findings';
import type { RawEventsPage } from '../src/fork/usage/event-index';

const { useUsageData } = vi.hoisted(() => ({ useUsageData: vi.fn() }));
vi.mock('../view/src/usage/use-usage-data', () => ({ useUsageData }));
import { FindingsPage } from '../view/src/usage/pages/findings-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const daily = [
  { day: '2026-01-01', count: 1 },
  { day: '2026-01-02', count: 3 },
];
const emptySearch: Finding = {
  kind: 'empty-search',
  id: 'empty-search:graph walk',
  subject: 'graph walk',
  count: 4,
  sessions: 2,
  first_seen: '2026-01-01T10:00:00.000Z',
  last_seen: '2026-01-02T11:00:00.000Z',
  daily,
  evidence: ['e1', 'e2'],
  suggestion: { section_id: 'cli#CLI#Walk', title: 'Walk', similarity: 0.5 },
};
const bypassed: Finding = {
  ...emptySearch,
  kind: 'bypassed-file',
  id: 'bypassed-file:lat.md/notes.md',
  subject: 'lat.md/notes.md',
  count: 2,
  suggestion: null,
};
const mystery: Finding = {
  ...emptySearch,
  kind: 'future-kind',
  id: 'future-kind:x',
  subject: 'x',
  first_seen: null,
  last_seen: null,
};
const rawPage: RawEventsPage = {
  next_cursor: null,
  records: [
    {
      type: 'usage',
      id: 'e1',
      ts: '2026-01-02T11:00:00.000Z',
      agent: 'claude',
      session_id: 'sess-1',
      issue_ids: ['lat-1', 'lat-2'],
      attribution: 'unattributed',
      event: { command: 'search', query: 'graph walk' },
    } as unknown as RawEventsPage['records'][number],
  ],
};

function serve(result: Partial<FindingsResult>, extra = {}) {
  useUsageData.mockImplementation((path: string) =>
    path === '/api/usage/raw'
      ? { data: rawPage, error: undefined, loading: false }
      : {
          data: { schema_version: 1, findings: [], errors: [], ...result },
          error: undefined,
          loading: false,
          ...extra,
        },
  );
}

describe('usage dashboard findings page', () => {
  let root: Root;
  let container: HTMLDivElement;
  const text = () => container.textContent!;
  const links = () => [...container.querySelectorAll('a')];
  async function show(id?: string, search = '') {
    window.history.replaceState(null, '', `/_usage/findings${search}`);
    await act(async () => root.render(createElement(FindingsPage, { id })));
  }

  beforeEach(() => {
    useUsageData.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#The list shows every finding kind with all columns]]
  it('lists every kind with all columns', async () => {
    serve({ findings: [emptySearch, bypassed, mystery] });
    await show();
    const headers = [...container.querySelectorAll('th')].map((th) =>
      th.textContent!.replace(/[▲▼]/g, '').trim(),
    );
    for (const header of [
      'Subject',
      'Kind',
      'Count',
      'Sessions',
      'First seen',
      'Last seen',
    ])
      expect(headers).toContain(header);
    for (const word of ['graph walk', 'lat.md/notes.md', 'future-kind'])
      expect(text()).toContain(word);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelectorAll('tbody [role="img"]')).toHaveLength(3);
    const unknownRow = [...container.querySelectorAll('tbody tr')].find((row) =>
      row.textContent!.includes('future-kind'),
    )!;
    expect(unknownRow.textContent).toContain('unknown');
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#Section findings show no invented measures]]
  it('shows a dash, not zero sessions or unknown dates, for section findings', async () => {
    const stale: Finding = {
      ...emptySearch,
      kind: 'stale-hot-section',
      id: 'stale-hot-section:cli#CLI',
      subject: 'cli#CLI',
      count: 7,
      sessions: 0,
      first_seen: null,
      last_seen: null,
      daily: daily.map((d) => ({ ...d, count: 0 })),
      evidence: [],
      suggestion: null,
    };
    const neverRead: Finding = {
      ...stale,
      kind: 'never-read-section',
      id: 'never-read-section:cli#Other',
      subject: 'cli#Other',
      count: 1,
    };
    serve({ findings: [stale, neverRead] });
    await show();
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
      expect(cells.slice(3, 6)).toEqual(['—', '—', '—']);
      expect(row.textContent).not.toContain('unknown');
      expect(row.querySelector('[role="img"]')).toBeNull();
    }
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#The kind filter narrows the list]]
  it('filters the list by kind', async () => {
    serve({ findings: [emptySearch, bypassed, mystery] });
    await show();
    const select = container.querySelector(
      'select[aria-label="Kind"]',
    ) as HTMLSelectElement;
    const choose = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        )!.set!.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    await choose('bypassed-file');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(text()).toContain('lat.md/notes.md');
    await choose('');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#Failed detectors are shown]]
  it('shows failed detectors and never claims no problems then', async () => {
    serve({ errors: [{ detector: 'empty-search', message: 'boom' }] });
    await show();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('empty-search');
    expect(alert.textContent).toContain('boom');
    expect(text()).not.toContain('No findings');
    serve({
      findings: [emptySearch],
      errors: [{ detector: 'x', message: 'm' }],
    });
    await show();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'x',
    );
    expect(text()).toContain('graph walk');
    serve({});
    await show();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain('No findings');
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#The detail view explains the finding]]
  it('explains a finding and suggests an action', async () => {
    serve({ findings: [emptySearch, bypassed, mystery] });
    await show(emptySearch.id);
    expect(text()).toContain('What it means');
    expect(text()).toContain('What to do');
    expect(text()).toContain('searched for returned nothing');
    expect(text()).toContain('cli#CLI#Walk');
    await show(bypassed.id);
    expect(text()).toContain('under lat.md/ directly instead of through lat');
    expect(text()).toContain('split the file if it is too large');
    await show(mystery.id);
    expect(text()).toContain('future-kind');
    expect(text()).toContain('What it means');
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#Every utilization kind has guidance]]
  it('explains the utilization kinds with the guide wording', async () => {
    const kinds: [string, string, string][] = [
      [
        'stale-hot-section',
        'references code that changed',
        'Review the section',
      ],
      ['uncovered-hot-file', 'file with no documentation', 'Write a section'],
      ['search-miss', 'did not find a section', 'Reword the expected section'],
    ];
    const findings = kinds.map(([kind]) => ({
      ...emptySearch,
      kind,
      id: `${kind}:x`,
      suggestion: null,
    }));
    serve({ findings });
    for (const [index, [, means, action]] of kinds.entries()) {
      await show(findings[index].id);
      expect(text()).toContain(means);
      expect(text()).toContain(action);
      expect(text()).not.toContain('no description in the dashboard');
    }
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#A search miss links its expected section]]
  it('links the expected section of a search miss to its Knowledge page', async () => {
    const sectionId = 'lat.md/cli#CLI#Walk/graph';
    const miss: Finding = {
      ...emptySearch,
      kind: 'search-miss',
      id: `search-miss:graph walk|${sectionId}`,
      suggestion: null,
      expected_section_id: sectionId,
    };
    serve({ findings: [miss] });
    await show(miss.id, '?agent=claude');
    const link = links().find((a) => a.textContent === sectionId);
    expect(link?.getAttribute('href')).toBe(
      `/_usage/knowledge/${encodeURIComponent(sectionId)}?agent=claude`,
    );
    expect(text()).toContain('Expected section');
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#The detail view lists the evidence events]]
  it('lists evidence events with session and issue links', async () => {
    serve({ findings: [emptySearch] });
    await show(emptySearch.id, '?agent=claude');
    expect(useUsageData).toHaveBeenCalledWith('/api/usage/raw', {
      ids: 'e1,e2',
    });
    expect(text()).toContain('e1');
    const hrefs = links().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/_usage/sessions/sess-1?agent=claude');
    expect(hrefs).toContain('/_usage/issues/lat-1?agent=claude');
    expect(hrefs).toContain('/_usage/issues/lat-2?agent=claude');
    expect(
      hrefs.some((h) => h?.startsWith('/_usage/explore?agent=claude')),
    ).toBe(true);
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#A finding without events fetches none]]
  it('fetches no events for a finding without evidence and says why', async () => {
    const stale: Finding = {
      ...emptySearch,
      kind: 'stale-hot-section',
      id: 'stale-hot-section:cli#CLI',
      subject: 'cli#CLI',
      count: 7,
      sessions: 0,
      first_seen: null,
      last_seen: null,
      evidence: [],
      suggestion: null,
    };
    const neverRead: Finding = {
      ...stale,
      kind: 'never-read-section',
      id: 'never-read-section:cli#CLI',
      count: 1,
    };
    serve({ findings: [stale, neverRead] });
    await show(stale.id);
    expect(text()).toContain('the section was read 7 times');
    expect(text()).toContain("its count is the section's reads");
    expect(text()).not.toContain('nothing read the section');
    expect(text()).not.toContain('events in 0 sessions');
    await show(neverRead.id);
    expect(text()).toContain(
      'never-read-section: no agent read this section in the selected period.',
    );
    expect(text()).toContain('nothing read the section');
    expect(text()).not.toContain('events in');
    expect(useUsageData).not.toHaveBeenCalledWith(
      '/api/usage/raw',
      expect.anything(),
    );
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#An unknown finding id says it no longer applies]]
  it('says an unknown finding no longer applies', async () => {
    serve({ findings: [emptySearch] });
    await show('gone:thing', '?agent=pi');
    expect(text()).toContain('no longer applies under the current filters');
    expect(
      links().some(
        (a) => a.getAttribute('href') === '/_usage/findings?agent=pi',
      ),
    ).toBe(true);
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#Links keep the filter query string]]
  it('keeps the filter query string on list links', async () => {
    serve({ findings: [bypassed] });
    await show(undefined, '?issue=lat-9&from=2026-01-01');
    const detail = links().find((a) => a.textContent === 'lat.md/notes.md')!;
    expect(detail.getAttribute('href')).toBe(
      `/_usage/findings/${encodeURIComponent(bypassed.id)}?from=2026-01-01&issue=lat-9`,
    );
  });

  // @lat: [[usage-dashboard-findings#Usage Dashboard Findings#Loading and error states]]
  it('shows loading and error states', async () => {
    useUsageData.mockReturnValue({
      data: undefined,
      error: undefined,
      loading: true,
    });
    await show();
    expect(text()).toContain('Loading');
    useUsageData.mockReturnValue({
      data: { schema_version: 1, findings: [emptySearch], errors: [] },
      error: new Error('stream broke'),
      loading: false,
    });
    await show();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'stream broke',
    );
    expect(text()).toContain('graph walk');
  });
});
