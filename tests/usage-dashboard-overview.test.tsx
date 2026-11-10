// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountedSum,
  DailyPoint,
  Totals,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
import type { Finding, FindingsResult } from '../src/fork/usage/findings';
import type { MissedKnowledge } from '../src/fork/usage/missed-knowledge';
import type { SavingsEstimate } from '../src/fork/usage/savings';

const { useUsageData } = vi.hoisted(() => ({ useUsageData: vi.fn() }));
vi.mock('../view/src/usage/use-usage-data', () => ({ useUsageData }));
import { OverviewPage } from '../view/src/usage/pages/overview-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const counted = (total: number | null): CountedSum => ({
  total,
  known: total === null ? 0 : 1,
  unknown: 0,
});

function totals(over: Partial<Totals> = {}): Totals {
  return {
    commands: 20,
    sessions: 4,
    searches: 10,
    zero_result_searches: 2,
    searches_unknown_results: 0,
    followed_searches: 5,
    reformulated_searches: 1,
    section_reads: 8,
    bypass_reads: 2,
    errors: 0,
    injected_events: 3,
    injected_bytes: counted(400),
    bytes_out: counted(100),
    latency_ms: { p50: 10, p95: 20 },
    tokens: {
      messages: 5,
      input: counted(1),
      output: counted(1),
      cache_read: counted(1),
      cache_write: counted(1),
      reasoning: counted(1),
      reported_cost_usd: counted(null),
    },
    zero_result_rate: 0.2,
    follow_through_rate: 0.5,
    reformulation_rate: 0.1,
    bypass_rate: 0.2,
    median_rank_opened: 1,
    lat_commands_per_session: 5,
    search_hit_rate: 0.8,
    ...over,
  };
}

const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
const daily = (per: Partial<Totals>[]): DailyPoint[] =>
  per.map((over, index) => ({ ...totals(over), day: days[index] }));

const savings: SavingsEstimate = {
  method_version: 3,
  label: 'correlation, not cause',
  bytes_per_token: { low: 3, point: 4, high: 5 },
  reads: 8,
  saved_bytes: counted(9000),
  injected_bytes: counted(400),
  unknown_reads: [],
  net_tokens_saved: { low: 1500, point: 2100, high: 2900 },
  reason: null,
};

const missed = {
  method_version: 1,
  totals: { reach: 0.75, reach_reason: null },
  previous: { reach: 0.5, reach_reason: null },
  daily: days.map((day, index) => ({
    day,
    sessions: 1,
    expected_sections: 4,
    reached: 3,
    reach: [0.5, null, 0.75][index],
  })),
} as unknown as MissedKnowledge;

function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    filters: {},
    range: {
      from: '2026-01-01',
      to: '2026-01-03',
      previous_from: '2025-12-29',
      previous_to: '2025-12-31',
    },
    days,
    totals: totals(),
    previous: totals({
      commands: 8,
      sessions: 4,
      zero_result_searches: 5,
      bypass_rate: 0.5,
      lat_commands_per_session: 4,
      follow_through_rate: 0.4,
      search_hit_rate: 0.7,
    }),
    daily: daily([
      {
        commands: 5,
        sessions: 1,
        lat_commands_per_session: 7,
        follow_through_rate: 0.3,
        search_hit_rate: 0.6,
      },
      {
        commands: 5,
        sessions: 0,
        bypass_rate: null,
        lat_commands_per_session: 9,
        follow_through_rate: null,
        search_hit_rate: null,
      },
      {
        commands: 10,
        sessions: 2,
        lat_commands_per_session: 8,
        follow_through_rate: 0.6,
        search_hit_rate: 0.9,
      },
    ]),
    signals: {
      lat_commands_per_session: 5,
      search_hit_rate: 0.8,
      follow_through_rate: 0.5,
      bypass_rate: 0.2,
      net_tokens_saved: 2100,
      net_tokens_saved_reason: null,
      injected_bytes: counted(400),
    },
    agents: [],
    sessions: [],
    issues: [],
    unattributed: {} as UsageSummary['unattributed'],
    commands: [
      {
        key: 'search',
        label: 'search',
        daily: daily([{ commands: 3 }, { commands: 2 }, { commands: 6 }]),
      },
      {
        key: 'section',
        label: 'section',
        daily: daily([{ commands: 2 }, { commands: 3 }, { commands: 4 }]),
      },
    ] as unknown as UsageSummary['commands'],
    queries: [],
    sections: [],
    documents: [],
    byDay: [],
    extensions: { savings, missed_knowledge: missed },
    ...over,
  };
}

const finding = (n: number): Finding => ({
  kind: 'empty-search',
  id: `empty-search:query ${n}`,
  subject: `query ${n}`,
  count: n,
  sessions: 1,
  first_seen: null,
  last_seen: null,
  daily: [],
  evidence: [],
  suggestion: null,
});

function serve(
  data: UsageSummary | undefined,
  findings: Partial<FindingsResult> = {},
  extra: { error?: Error; loading?: boolean } = {},
) {
  useUsageData.mockImplementation((path: string) =>
    path === '/api/usage/findings'
      ? {
          data: { schema_version: 1, findings: [], errors: [], ...findings },
          error: undefined,
          loading: false,
        }
      : { data, error: extra.error, loading: extra.loading ?? false },
  );
}

describe('usage dashboard overview page', () => {
  let root: Root;
  let container: HTMLDivElement;
  const text = () => container.textContent!;
  const tile = (name: string) =>
    container.querySelector(`article[aria-label="${name}"]`)!;
  async function show(search = '') {
    window.history.replaceState(null, '', `/_usage${search}`);
    await act(async () => root.render(createElement(OverviewPage, {})));
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

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Each signal tile shows value, change and a sparkline]]
  it('shows value, change and a sparkline on each signal tile', async () => {
    serve(summary());
    await show();
    expect(container.querySelector('h1')!.textContent).toBe('Overview');
    const adoption = tile('Adoption');
    expect(adoption.textContent).toContain('5');
    expect(adoption.textContent).toContain('+1');
    expect(
      adoption.querySelector('[role="img"]')!.getAttribute('aria-label'),
    ).toContain('min 7, max 9, last 8');
    expect(adoption.querySelector('[role="img"]')).not.toBeNull();
    const search = tile('Search success');
    expect(search.textContent).toContain('50%');
    expect(search.textContent).toContain('+10 points');
    expect(search.textContent).not.toContain('80%');
    expect(search.textContent).toContain(
      'Share of searches followed by a section read.',
    );
    expect(
      search.querySelector('[role="img"]')!.getAttribute('aria-label'),
    ).toContain('min 0.3, max 0.6, last 0.6, 1 unknown');
    expect(search.querySelector('[role="img"]')).not.toBeNull();
    const bypass = tile('Bypass rate');
    expect(bypass.textContent).toContain('20%');
    expect(bypass.textContent).toContain('-30 points');
    expect(bypass.querySelector('[role="img"]')).not.toBeNull();
    const reach = tile('Knowledge reach');
    expect(reach.textContent).toContain('75%');
    expect(reach.textContent).toContain('+25 points');
    expect(reach.querySelector('[role="img"]')).not.toBeNull();
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#An unknown signal says unknown with its reason]]
  it('says unknown with a reason and never 0', async () => {
    serve(
      summary({
        previous: null,
        signals: {
          lat_commands_per_session: null,
          search_hit_rate: null,
          follow_through_rate: null,
          bypass_rate: null,
          net_tokens_saved: null,
          net_tokens_saved_reason: 'boom',
          injected_bytes: counted(null),
        },
        extensions: {
          missed_knowledge: { error: 'no graph snapshot' },
        },
      }),
    );
    await show();
    for (const name of ['Adoption', 'Search success', 'Bypass rate'])
      expect(tile(name).textContent).toContain('unknown');
    expect(tile('Adoption').textContent).not.toMatch(/\b0\b/);
    expect(tile('Adoption').textContent).toContain('no previous range');
    expect(tile('Knowledge reach').textContent).toContain(
      'unknown (no graph snapshot)',
    );
    serve(
      summary({
        extensions: {
          savings,
          missed_knowledge: {
            ...missed,
            totals: { reach: null, reach_reason: 'no edits' },
          },
        },
      }),
    );
    await show();
    expect(tile('Knowledge reach').textContent).toContain('unknown (no edits)');
    serve(summary({ extensions: {} }));
    await show();
    expect(tile('Knowledge reach').textContent).toContain('unknown');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Net tokens saved shows range, cost, method version and the correlation label]]
  it('shows the net tokens saved range, cost, method and label', async () => {
    serve(summary());
    await show();
    const net = tile('Net tokens saved');
    expect(net.textContent).toContain('2,100');
    expect(net.textContent).toContain('1,500');
    expect(net.textContent).toContain('2,900');
    expect(net.textContent).toContain('Method version 3');
    expect(net.textContent).toContain('correlation, not cause');
    // Injected cost in tokens: 400 bytes at 4 bytes per token.
    expect(net.querySelector('[data-mark="cost"]')).not.toBeNull();
    expect(net.querySelector('[data-field="injected-cost"]')!.textContent).toBe(
      'Injected cost: 100 tokens',
    );
    const costRow = [...net.querySelectorAll('tbody tr')].find(
      (row) => row.firstElementChild!.textContent === 'Injected cost',
    )!;
    expect(costRow.lastElementChild!.textContent).toBe('100');
    expect(net.querySelector('[data-mark="range"]')).not.toBeNull();
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Net tokens saved shows range, cost, method version and the correlation label]]
  it('shows the unknown read count beside the range', async () => {
    const partial = {
      ...savings,
      saved_bytes: { total: 9000, known: 8, unknown: 3 },
      unknown_reads: [
        { reason: 'a', count: 2 },
        { reason: 'b', count: 1 },
      ],
    };
    serve(summary({ extensions: { savings: partial } }));
    await show();
    expect(tile('Net tokens saved').textContent).toContain(
      '2,100 (1,500 to 2,900) (+3 reads unknown)',
    );
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Net tokens saved shows range, cost, method version and the correlation label]]
  it('does not count a hook of unknown injected size as an unknown read', async () => {
    const partial = {
      ...savings,
      injected_bytes: { total: 400, known: 1, unknown: 1 },
      unknown_reads: [{ reason: 'injected_bytes not captured', count: 1 }],
    };
    serve(summary({ extensions: { savings: partial } }));
    await show();
    const text = tile('Net tokens saved').textContent!;
    expect(text).toContain('2,100 (1,500 to 2,900)');
    expect(text).not.toContain('reads unknown');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Net tokens saved shows range, cost, method version and the correlation label]]
  it('shows unknown injected bytes beside the known injected cost', async () => {
    const partial = {
      ...savings,
      injected_bytes: { total: 400, known: 1, unknown: 2 },
    };
    serve(summary({ extensions: { savings: partial } }));
    await show();
    expect(
      tile('Net tokens saved').querySelector('[data-field="injected-cost"]')!
        .textContent,
    ).toBe('Injected cost: 100 tokens (+2 unknown)');
    expect(tile('Net tokens saved').textContent).toContain(
      'Injected cost (known part)',
    );
    serve(
      summary({
        extensions: {
          savings: { ...savings, injected_bytes: counted(null) },
        },
      }),
    );
    await show();
    expect(
      tile('Net tokens saved').querySelector('[data-field="injected-cost"]')!
        .textContent,
    ).toBe('Injected cost: unknown');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Unknown net tokens saved shows its reason]]
  it('shows unknown net tokens saved with its reason', async () => {
    for (const extensions of [
      {},
      { savings: { error: 'snapshot failed' } },
      { savings: { ...savings, net_tokens_saved: null, reason: 'no reads' } },
    ]) {
      serve(
        summary({
          extensions,
          signals: {
            ...summary().signals,
            net_tokens_saved: null,
            net_tokens_saved_reason: 'not computed',
          },
        }),
      );
      await show();
      const net = tile('Net tokens saved');
      expect(net.textContent).toContain('unknown');
      expect(net.textContent).toContain('correlation, not cause');
      expect(net.querySelector('[data-mark="range"]')).toBeNull();
    }
    serve(summary({ extensions: { savings: { error: 'snapshot failed' } } }));
    await show();
    expect(tile('Net tokens saved').textContent).toContain('snapshot failed');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Commands per day are stacked by command]]
  it('stacks commands per day by command', async () => {
    serve(summary());
    await show();
    const chart = container.querySelector('[aria-label="Commands per day"]')!;
    expect(chart).not.toBeNull();
    expect(chart.textContent).toContain('search');
    expect(chart.textContent).toContain('section');
    expect(chart.textContent).toContain('2026-01-03');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#The top five findings link to their detail pages]]
  it('lists the top five findings with links and failed detectors', async () => {
    serve(summary(), {
      findings: [1, 2, 3, 4, 5, 6, 7].map(finding),
      errors: [{ detector: 'bypassed-file', message: 'kaput' }],
    });
    await show();
    const list = container.querySelector('[aria-label="Top findings"]')!;
    const items = [...list.querySelectorAll('li')];
    expect(items).toHaveLength(5);
    expect(items[0].textContent).toContain('query 7');
    expect(text()).not.toContain('query 2');
    const hrefs = [...list.querySelectorAll('a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toContain(
      `/_usage/findings/${encodeURIComponent('empty-search:query 7')}`,
    );
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('bypassed-file');
    expect(alert.textContent).toContain('kaput');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#A stale hot section counts reads]]
  it('labels a stale hot section count as reads', async () => {
    serve(summary(), {
      findings: [
        {
          ...finding(400),
          kind: 'stale-hot-section',
          id: 'stale-hot-section:a#B',
          subject: 'a#B',
        },
        finding(3),
        {
          ...finding(1),
          kind: 'never-read-section',
          id: 'never-read-section:c#D',
          subject: 'c#D',
          sessions: 0,
        },
      ],
    });
    await show();
    const items = [
      ...container.querySelectorAll('[aria-label="Top findings"] li'),
    ].map((item) => item.textContent);
    expect(items[0]).toContain('(stale-hot-section, 400 reads)');
    expect(items[1]).toContain('(empty-search, 3 events)');
    expect(items[2]).toContain('c#D (never-read-section)');
    expect(items[2]).not.toContain('events');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#The top five findings link to their detail pages]]
  it('ranks top findings by sessions before count', async () => {
    serve(summary(), {
      findings: [finding(50), { ...finding(2), sessions: 3 }],
    });
    await show();
    const items = [
      ...container.querySelectorAll('[aria-label="Top findings"] li'),
    ].map((item) => item.textContent);
    expect(items[0]).toContain('query 2');
    expect(items[1]).toContain('query 50');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#With no events the page shows how to enable tracking]]
  it('shows how to enable tracking when there are no events', async () => {
    serve(
      summary({
        totals: totals({
          commands: 0,
          sessions: 0,
          injected_events: 0,
          bypass_reads: 0,
          tokens: { ...totals().tokens, messages: 0 },
        }),
      }),
    );
    await show();
    expect(text()).toContain('lat usage enable');
    expect(container.querySelector('article')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    await show('?agent=codex');
    expect(text()).toContain('No events match the current filters.');
    expect(text()).not.toContain('lat usage enable');
    expect(container.querySelector('article')).toBeNull();
    serve(
      summary({
        signals: {
          ...summary().signals,
          search_hit_rate: null,
          follow_through_rate: null,
          lat_commands_per_session: null,
        },
      }),
    );
    await show();
    expect(text()).not.toContain('lat usage enable');
    expect(container.querySelector('article')).not.toBeNull();
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Links keep the filter query string]]
  it('keeps the filter query string on every link', async () => {
    serve(summary(), { findings: [finding(3)] });
    await show('?issue=lat-9&from=2026-01-01');
    const hrefs = [...container.querySelectorAll('a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs)
      expect(href).toContain('?from=2026-01-01&issue=lat-9');
    expect(hrefs).toContain(
      `/_usage/findings/${encodeURIComponent('empty-search:query 3')}?from=2026-01-01&issue=lat-9`,
    );
    expect(hrefs).toContain('/_usage/findings?from=2026-01-01&issue=lat-9');
  });

  // @lat: [[usage-dashboard-overview#Usage Dashboard Overview#Loading and error states]]
  it('shows loading and error states', async () => {
    serve(undefined, {}, { loading: true });
    await show();
    expect(text()).toContain('Loading');
    serve(summary(), {}, { error: new Error('stream broke') });
    await show();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'stream broke',
    );
    expect(tile('Adoption')).not.toBeNull();
  });
});
