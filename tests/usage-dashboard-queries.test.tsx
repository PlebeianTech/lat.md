// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountedSum,
  DailyPoint,
  QueryRow,
  Totals,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
import type { RawEventsPage, RawRecord } from '../src/fork/usage/event-index';
import { QueriesPage } from '../view/src/usage/pages/queries-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

const sum = (total: number | null): CountedSum => ({
  total,
  known: total === null ? 0 : 1,
  unknown: 0,
});

function totals(searches: number): Totals {
  return {
    commands: searches,
    sessions: 1,
    searches,
    zero_result_searches: 0,
    searches_unknown_results: 0,
    followed_searches: 0,
    reformulated_searches: 0,
    section_reads: 0,
    bypass_reads: 0,
    errors: 0,
    injected_events: 0,
    injected_bytes: sum(0),
    bytes_out: sum(0),
    latency_ms: { p50: null, p95: null },
    tokens: {
      messages: 0,
      input: sum(0),
      output: sum(0),
      cache_read: sum(0),
      cache_write: sum(0),
      reasoning: sum(0),
      reported_cost_usd: sum(null),
    },
    zero_result_rate: null,
    follow_through_rate: null,
    reformulation_rate: null,
    bypass_rate: null,
    median_rank_opened: null,
  };
}

function query(key: string, extra: Partial<QueryRow> = {}): QueryRow {
  const daily: DailyPoint[] = [
    { day: '2026-01-01', ...totals(1) },
    { day: '2026-01-02', ...totals(2) },
  ];
  return {
    key,
    label: key,
    totals: totals(3),
    previous: null,
    daily,
    signals: {
      lat_commands_per_session: null,
      search_success: null,
      bypass_rate: null,
      net_tokens_saved: null,
      net_tokens_saved_reason: null,
      injected_bytes: sum(0),
    },
    count: 3,
    sessions: 2,
    result_count: 4,
    empty_share: 0.25,
    follow_through_share: 0.5,
    median_rank_opened: 2,
    sections_returned: [],
    reformulations: 0,
    ...extra,
  };
}

const parser = query('how does the parser work', {
  count: 12,
  sessions: 3,
  result_count: 5,
  empty_share: 0.1,
  follow_through_share: 0.75,
  median_rank_opened: 2,
  reformulations: 1,
  sections_returned: [
    { section_id: 'cli#CLI#Search', returned: 3, opened: 2 },
    { section_id: 'cli#CLI#Check', returned: 2, opened: 0 },
  ],
});
const lost = query('nothing matches this', {
  count: 5,
  empty_share: 0.9,
  result_count: 0,
});
const blank = query('unmeasured', {
  count: 1,
  result_count: null,
  empty_share: null,
  follow_through_share: null,
  median_rank_opened: null,
});

const base = {
  agent: 'claude' as const,
  issue_ids: [],
  attribution: 'unattributed' as const,
};
const search = (
  id: string,
  ts: string,
  queryText: string | null,
  resultIds: string[],
  session = 'sess-1',
) =>
  ({
    ...base,
    type: 'usage',
    id,
    ts,
    session_id: session,
    event: {
      event_id: id,
      ts,
      command: 'search',
      surface: 'cli',
      caller: 'agent',
      query: queryText,
      result_ids: resultIds,
      result_count: resultIds.length,
      section_id: null,
    },
  }) as unknown as RawRecord;
const read = (id: string, ts: string, sectionId: string, session = 'sess-1') =>
  ({
    ...base,
    type: 'usage',
    id,
    ts,
    session_id: session,
    event: {
      event_id: id,
      ts,
      command: 'section',
      surface: 'cli',
      caller: 'agent',
      query: null,
      result_ids: [],
      section_id: sectionId,
    },
  }) as unknown as RawRecord;

// sess-1: the parser query returns [Check, Search, Other]; Search is read at rank 2,
// then a second search follows within 60 seconds (a reformulation). sess-2: Search read at
// rank 1 after the same query. A later search in sess-1, over a minute on, is no reformulation.
const baseEvents: RawRecord[] = [
  search('s1', '2026-01-02T10:00:00.000Z', 'How does  the parser work', [
    'cli#CLI#Check',
    'cli#CLI#Search',
    'cli#CLI#Other',
  ]),
  read('r1', '2026-01-02T10:00:05.000Z', 'cli#CLI#Search'),
  search('s2', '2026-01-02T10:00:30.000Z', 'parser internals', []),
  search('s3', '2026-01-02T10:05:00.000Z', 'much later', []),
  search(
    's4',
    '2026-01-03T09:00:00.000Z',
    'how does the parser work',
    ['cli#CLI#Search'],
    'sess-2',
  ),
  read('r2', '2026-01-03T09:00:02.000Z', 'cli#CLI#Search', 'sess-2'),
];

describe('usage dashboard queries page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let queries: QueryRow[];
  let events: RawRecord[];
  let failSummary: string | undefined;
  let failRaw: string | undefined;
  let hang = false;
  const text = () => container.textContent!;
  const hrefs = () =>
    [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const rows = () => [
    ...container.querySelectorAll('[data-entity-table] tbody tr'),
  ];
  const cells = (tr: Element) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent!);
  const headers = () =>
    [...container.querySelectorAll('[data-entity-table] th')].map((th) =>
      th.textContent!.replace(/[▲▼]/g, '').trim(),
    );

  async function show(id?: string, searchString = '') {
    window.history.replaceState(null, '', `/_usage/queries${searchString}`);
    await act(async () => root.render(createElement(QueriesPage, { id })));
    await act(async () => {});
  }

  beforeEach(() => {
    queries = [parser, lost, blank];
    events = baseEvents;
    failSummary = undefined;
    failRaw = undefined;
    hang = false;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (hang) return new Promise<never>(() => {});
        const path = url.split('?')[0];
        const failure = path === '/api/usage/raw' ? failRaw : failSummary;
        if (failure)
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: failure }),
          };
        const body =
          path === '/api/usage/raw'
            ? ({ records: events, next_cursor: null } satisfies RawEventsPage)
            : ({ queries } as unknown as UsageSummary);
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#The table shows every column and sorts by empty-result share]]
  it('shows every column and sorts by empty-result share', async () => {
    await show();
    for (const header of [
      'Query',
      'Searches',
      'Sessions',
      'Median results',
      'Empty-result share',
      'Followed by a read',
      'Median rank opened',
      'Reformulations',
    ])
      expect(headers()).toContain(header);
    const row = cells(
      rows().find((tr) => tr.textContent!.includes('how does the parser'))!,
    );
    expect(row.slice(0, 8)).toEqual([
      'how does the parser work',
      '12',
      '3',
      '5',
      '10%',
      '75%',
      '2',
      '1',
    ]);
    expect(
      container.querySelector('[data-entity-table] tbody tr [role="img"]'),
    ).not.toBeNull();
    const sortButton = [...container.querySelectorAll('th button')].find((b) =>
      b.textContent!.startsWith('Empty-result share'),
    )!;
    await click(sortButton);
    expect(rows().map((tr) => cells(tr)[0])).toEqual([
      'how does the parser work',
      'nothing matches this',
      'unmeasured',
    ]);
    await click(sortButton);
    expect(rows().map((tr) => cells(tr)[0])).toEqual([
      'nothing matches this',
      'how does the parser work',
      'unmeasured',
    ]);
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#The detail view shows returned sections, opened ranks and reformulations]]
  it('shows returned sections, opened ranks and reformulations', async () => {
    await show('how does the parser work');
    expect(text()).toContain('Queries');
    expect(container.querySelector('h1')!.textContent).toBe(
      'how does the parser work',
    );
    const sections = container.querySelector(
      '[aria-label="Sections returned"]',
    )!;
    const searchRow = [...sections.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent!.includes('cli#CLI#Search'),
    )!;
    // returned 3, opened 2, at ranks 1 and 2.
    expect(cells(searchRow)).toEqual(['cli#CLI#Search', '3', '2', '1, 2']);
    const checkRow = [...sections.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent!.includes('cli#CLI#Check'),
    )!;
    expect(cells(checkRow)).toEqual(['cli#CLI#Check', '2', '0', 'none']);
    const reformulations = container.querySelector(
      '[aria-label="Reformulations"]',
    )!;
    expect(reformulations.textContent).toContain('parser internals');
    expect(reformulations.textContent).not.toContain('much later');
    expect(
      container.querySelector('[role="img"][aria-label^="Searches per day"]'),
    ).not.toBeNull();
    const summaryText = container.querySelector(
      '[aria-label="Query summary"]',
    )!.textContent!;
    for (const word of ['12', '75%', '10%'])
      expect(summaryText).toContain(word);
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#The detail view shows returned sections, opened ranks and reformulations]]
  it('counts reformulations as the server rule does, null-query follow-ups included', async () => {
    // Searches of "parity" in sess-3: p1 then a null-query search 10 s later
    // (reformulated), p2 then a search 20 s later (reformulated), p3 then a
    // search 90 s later (not). Two reads of one section after p1 both open it at
    // rank 1, and the server counts both: ranks are not deduped.
    events = [
      search('p1', '2026-02-01T10:00:00.000Z', 'Parity', ['x#X'], 'sess-3'),
      read('pr1', '2026-02-01T10:00:01.000Z', 'x#X', 'sess-3'),
      read('pr2', '2026-02-01T10:00:02.000Z', 'x#X', 'sess-3'),
      search('pn', '2026-02-01T10:00:10.000Z', null, [], 'sess-3'),
      search('p2', '2026-02-01T10:01:00.000Z', 'parity', ['x#X'], 'sess-3'),
      search('pf', '2026-02-01T10:01:20.000Z', 'other', [], 'sess-3'),
      search('p3', '2026-02-01T10:05:00.000Z', 'parity', ['x#X'], 'sess-3'),
      search('pl', '2026-02-01T10:06:30.000Z', 'later', [], 'sess-3'),
    ];
    queries = [
      query('parity', {
        count: 3,
        reformulations: 2,
        sections_returned: [{ section_id: 'x#X', returned: 3, opened: 2 }],
      }),
    ];
    await show('parity');
    const items = [
      ...container.querySelectorAll('[aria-label="Reformulations"] li'),
    ];
    const total = items.reduce(
      (n, li) => n + Number(/\((\d+)\)/.exec(li.textContent!)![1]),
      0,
    );
    expect(total).toBe(queries[0].reformulations);
    expect(items.map((li) => li.textContent)).toContain(
      'no query recorded (1)',
    );
    expect(
      cells(
        container.querySelector('[aria-label="Sections returned"] tbody tr')!,
      )[3],
    ).toBe('1, 1');
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#Another query never shows the previous query's facts]]
  it("shows the next query's facts, not the previous query's", async () => {
    await show('how does the parser work');
    expect(
      container.querySelector('[aria-label="Reformulations"]')!.textContent,
    ).toContain('parser internals');
    hang = true;
    await act(async () =>
      root.render(createElement(QueriesPage, { id: 'nothing matches this' })),
    );
    expect(container.querySelector('h1')!.textContent).toBe(
      'nothing matches this',
    );
    expect(text()).not.toContain('parser internals');
    expect(text()).not.toContain('cli#CLI#Search');
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#Unknown values are shown as unknown]]
  it('shows null measures as unknown, never 0', async () => {
    await show();
    const row = cells(
      rows().find((tr) => tr.textContent!.includes('unmeasured'))!,
    );
    expect(row.slice(3, 7)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    await show('unmeasured');
    const summaryText = container.querySelector(
      '[aria-label="Query summary"]',
    )!.textContent!;
    expect(summaryText).toContain('unknown');
    for (const phrase of [
      'Median results unknown',
      'empty-result share unknown',
      'followed by a read unknown',
      'median rank opened unknown',
    ])
      expect(summaryText).toContain(phrase);
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#Links keep the filter query string]]
  it('keeps the filter query string on every link', async () => {
    const filters = '?agent=claude&session=s-1';
    await show(undefined, filters);
    expect(hrefs()).toContain(
      `/_usage/queries/${encodeURIComponent('how does the parser work')}${filters}`,
    );
    await show('how does the parser work', filters);
    expect(hrefs()).toContain(`/_usage/queries${filters}`);
    expect(hrefs()).toContain(
      `/_usage/knowledge/${encodeURIComponent('cli#CLI#Search')}${filters}`,
    );
    expect(hrefs()).toContain(
      `/_usage/queries/${encodeURIComponent('parser internals')}${filters}`,
    );
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#Loading and error states]]
  it('shows loading, error and empty states', async () => {
    hang = true;
    await show();
    expect(text()).toContain('Loading');
    await act(async () => root.unmount());
    root = createRoot(container);
    hang = false;
    queries = [];
    await show();
    expect(text()).toContain('No queries under the current filters');
    queries = [lost];
    await show(undefined, '?agent=claude');
    expect(text()).toContain('nothing matches this');
    failSummary = 'stream broke';
    await show(undefined, '?agent=pi');
    expect(text()).toContain('nothing matches this');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'stream broke',
    );
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#Loading and error states]]
  it('says so when a detail query is not in the summary or its events fail', async () => {
    await show('never searched');
    expect(text()).toContain('not in the summary');
    failRaw = 'raw broke';
    await show('how does the parser work');
    expect(text()).toContain('raw broke');
    expect(text()).toContain('how does the parser work');
  });
});
