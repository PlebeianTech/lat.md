// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountedSum,
  DailyPoint,
  QueryDetailRow,
  Totals,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
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
    lat_commands_per_session: null,
    search_hit_rate: null,
  };
}

function query(
  key: string,
  extra: Partial<QueryDetailRow> = {},
): QueryDetailRow {
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
      search_hit_rate: null,
      follow_through_rate: null,
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
    facts: { opened_ranks: {}, reformulated_to: [] },
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
  facts: {
    opened_ranks: { 'cli#CLI#Search': [1, 2] },
    reformulated_to: [{ query: 'parser internals', count: 1 }],
  },
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

describe('usage dashboard queries page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let queries: QueryDetailRow[];
  let failSummary: string | undefined;
  let hang = false;
  let fetched: string[];
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
    failSummary = undefined;
    hang = false;
    fetched = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (hang) return new Promise<never>(() => {});
        fetched.push(url);
        if (failSummary)
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: failSummary }),
          };
        return {
          ok: true,
          status: 200,
          json: async () => ({ queries }) as unknown as UsageSummary,
        };
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

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#The detail view renders the facts the server sends]]
  it('renders the server facts without requesting raw events', async () => {
    queries = [
      query('parity', {
        count: 3,
        reformulations: 2,
        sections_returned: [{ section_id: 'x#X', returned: 3, opened: 2 }],
        facts: {
          opened_ranks: { 'x#X': [1, 1] },
          reformulated_to: [
            { query: null, count: 1 },
            { query: 'other', count: 1 },
          ],
        },
      }),
    ];
    await show('parity');
    expect(
      cells(
        container.querySelector('[aria-label="Sections returned"] tbody tr')!,
      )[3],
    ).toBe('1, 1');
    expect(
      [...container.querySelectorAll('[aria-label="Reformulations"] li')].map(
        (li) => li.textContent,
      ),
    ).toEqual(['no query recorded (1)', 'other (1)']);
    expect(fetched.some((url) => url.includes('/api/usage/raw'))).toBe(false);
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#A section id named like an object property shows no inherited ranks]]
  it('renders section ids such as __proto__ and constructor', async () => {
    queries = [
      query('planted', {
        sections_returned: [
          { section_id: '__proto__', returned: 2, opened: 1 },
          { section_id: 'constructor', returned: 2, opened: 0 },
          { section_id: 'toString', returned: 2, opened: 0 },
        ],
        facts: {
          // fromEntries makes __proto__ an own key, as JSON.parse does.
          opened_ranks: Object.fromEntries([['__proto__', [3]]]),
          reformulated_to: [],
        },
      }),
    ];
    await show('planted');
    expect(
      [
        ...container.querySelectorAll(
          '[aria-label="Sections returned"] tbody tr',
        ),
      ].map(cells),
    ).toEqual([
      ['__proto__', '2', '1', '3'],
      ['constructor', '2', '0', 'none'],
      ['toString', '2', '0', 'none'],
    ]);
  });

  // @lat: [[usage-dashboard-queries#Usage Dashboard Queries#Another query never shows the previous query's facts]]
  it("shows the next query's facts, not the previous query's", async () => {
    await show('how does the parser work');
    expect(
      container.querySelector('[aria-label="Reformulations"]')!.textContent,
    ).toContain('parser internals');
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
  it('says so when a detail query is not in the summary', async () => {
    await show('never searched');
    expect(text()).toContain('not in the summary');
  });
});
