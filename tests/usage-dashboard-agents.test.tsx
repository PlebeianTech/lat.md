// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRow,
  CountedSum,
  HealthSignals,
  Totals,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
import { AgentsPage } from '../view/src/usage/pages/agents-page';

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

function totals(sessions: number, commands: number): Totals {
  return {
    commands,
    sessions,
    searches: commands,
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

function agent(
  key: string,
  sessions: number,
  signals: Partial<HealthSignals>,
): AgentRow {
  return {
    key,
    label: key,
    totals: totals(sessions, sessions * 4),
    previous: null,
    daily: [],
    signals: {
      lat_commands_per_session: sessions === 0 ? null : 4,
      search_success: null,
      bypass_rate: null,
      net_tokens_saved: null,
      net_tokens_saved_reason: null,
      injected_bytes: sum(0),
      ...signals,
    },
    reason: null,
  };
}

// codex has many sessions but a worse bypass rate; pi has one session and a
// perfect search success. antigravity has no sessions at all; opencode is absent.
const claude = agent('claude', 10, {
  lat_commands_per_session: 6,
  search_success: 0.9,
  bypass_rate: 0.1,
  net_tokens_saved: 1000,
});
const codex = agent('codex', 40, {
  lat_commands_per_session: 2,
  search_success: 0.5,
  bypass_rate: 0.6,
  net_tokens_saved: 400,
});
const pi = agent('pi', 1, {
  lat_commands_per_session: 3,
  search_success: 1,
  bypass_rate: 0,
  net_tokens_saved: null,
  net_tokens_saved_reason: 'no baseline',
});
const antigravity = agent('antigravity', 0, {});

describe('usage dashboard agents page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let agents: AgentRow[];
  let failure: string | undefined;
  let hang = false;
  const text = () => container.textContent!;
  const hrefs = () =>
    [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
  const rows = () => [
    ...container.querySelectorAll('[data-entity-table] tbody tr'),
  ];
  const cells = (tr: Element) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent!);
  const chartText = (name: string) =>
    container.querySelector(`[role="group"][aria-label^="${name}"]`)!
      .textContent!;

  /** Item label to value, read from a chart's hidden value table. */
  const chartValues = (name: string) =>
    Object.fromEntries(
      [
        ...container
          .querySelector(`[role="group"][aria-label^="${name}"]`)!
          .querySelectorAll('tbody tr'),
      ].map((tr) => [cells(tr)[1], cells(tr)[2]]),
    );

  async function show(id?: string, searchString = '') {
    window.history.replaceState(null, '', `/_usage/agents${searchString}`);
    await act(async () => root.render(createElement(AgentsPage, { id })));
    await act(async () => {});
  }

  beforeEach(() => {
    agents = [claude, codex, pi, antigravity];
    failure = undefined;
    hang = false;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (hang) return new Promise<never>(() => {});
        if (failure)
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: failure }),
          };
        const body = {
          agents,
          extensions: { savings: { method_version: 'v2' } },
        } as unknown as UsageSummary;
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

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Each signal compares agents per session]]
  it('compares agents per session on every signal', async () => {
    await show();
    expect(container.querySelector('h1')!.textContent).toBe('Agents');
    expect(chartValues('Lat commands per session')).toMatchObject({
      claude: '6',
      codex: '2',
      pi: '3',
      antigravity: 'unknown',
    });
    expect(chartValues('Search success')).toMatchObject({
      claude: '90',
      codex: '50',
    });
    expect(chartValues('Bypass rate')).toMatchObject({
      claude: '10',
      codex: '60',
    });
    // 1000 over 10 sessions and 400 over 40 sessions, never the raw totals.
    const savedName = 'Net tokens saved per session';
    expect(chartValues(savedName)).toMatchObject({
      claude: '100',
      codex: '10',
      pi: 'unknown',
    });
    const saved = chartText(savedName);
    expect(saved).toContain('correlation, not cause');
    expect(saved).toContain('v2');
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Selecting an agent sets the agent filter and opens Overview]]
  it('selecting an agent filters by it and opens Overview', async () => {
    await show(undefined, '?from=2026-01-01&agent=claude');
    const codexRow = rows().find((tr) => cells(tr)[0].startsWith('codex'))!;
    const link = codexRow.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(
      '/_usage?from=2026-01-01&agent=codex',
    );
    await click(link);
    expect(window.location.pathname).toBe('/_usage');
    expect(new URLSearchParams(window.location.search).get('agent')).toBe(
      'codex',
    );
    expect(new URLSearchParams(window.location.search).get('from')).toBe(
      '2026-01-01',
    );
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#An agent with no sessions shows a no-sessions row]]
  it('shows a no-sessions row for an agent without sessions, even an absent one', async () => {
    await show();
    const names = rows().map((tr) => cells(tr)[0]);
    for (const name of ['claude', 'codex', 'antigravity', 'pi', 'opencode'])
      expect(names.some((n) => n.startsWith(name))).toBe(true);
    for (const name of ['antigravity', 'opencode']) {
      const row = rows().find((tr) => cells(tr)[0].startsWith(name))!;
      expect(cells(row)[0]).toContain('no sessions in range');
      expect(cells(row)[1]).toBe('0');
      expect(cells(row).slice(2)).toEqual([
        'unknown',
        'unknown',
        'unknown',
        'unknown',
      ]);
    }
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Unknown values are shown as unknown]]
  it('shows an unknown net tokens saved as unknown with its reason', async () => {
    await show();
    const row = rows().find((tr) => cells(tr)[0].startsWith('pi'))!;
    expect(cells(row).slice(1)).toEqual(['1', '3', '100%', '0%', 'unknown']);
    expect(text()).toContain('no baseline');
    expect(
      [...container.querySelectorAll('th')].some((th) =>
        th.textContent!.includes('correlation, not cause, method v2'),
      ),
    ).toBe(true);
    expect(text()).toContain('correlation, not cause');
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Links keep the filter query string]]
  it('keeps the filter query string on every link and an agent detail path lists agents', async () => {
    const filters = '?agent=claude&session=s-1';
    await show(undefined, filters);
    expect(hrefs()).toContain('/_usage?agent=codex&session=s-1');
    await show('codex', filters);
    expect(container.querySelector('h1')!.textContent).toBe('Agents');
    expect(hrefs()).toContain('/_usage?agent=codex&session=s-1');
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Loading, error and empty states]]
  it('shows a loading state before the first data', async () => {
    hang = true;
    await show();
    expect(text()).toContain('Loading agents');
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Loading, error and empty states]]
  it('shows an error message', async () => {
    failure = 'boom';
    await show();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'boom',
    );
  });

  // @lat: [[usage-dashboard-agents#Usage Dashboard Agents#Loading, error and empty states]]
  it('shows a no-sessions message and still lists the five agents', async () => {
    agents = [];
    await show();
    expect(text()).toContain('No agent sessions under the current filters');
    expect(rows()).toHaveLength(5);
  });
});
