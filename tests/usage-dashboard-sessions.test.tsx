// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountedSum,
  SessionRow,
  Stats,
  Totals,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
import type { RawEventsPage, RawRecord } from '../src/fork/usage/event-index';
import { SessionsPage } from '../view/src/usage/pages/sessions-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

const sum = (total: number | null, unknown = 0): CountedSum => ({
  total,
  known: total === null ? 0 : 1,
  unknown,
});

function totals(overrides: {
  commands?: number;
  bypass_reads?: number;
  tokens?: number | null;
  unknownTokens?: number;
}): Totals {
  const tokens = overrides.tokens === undefined ? 10 : overrides.tokens;
  return {
    commands: overrides.commands ?? 0,
    sessions: 1,
    searches: 0,
    zero_result_searches: 0,
    searches_unknown_results: 0,
    followed_searches: 0,
    reformulated_searches: 0,
    section_reads: 0,
    bypass_reads: overrides.bypass_reads ?? 0,
    errors: 0,
    injected_events: 0,
    injected_bytes: sum(0),
    bytes_out: sum(0),
    latency_ms: { p50: null, p95: null },
    tokens: {
      messages: 0,
      input: sum(tokens, overrides.unknownTokens ?? 0),
      output: sum(tokens),
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

function session(
  key: string,
  overrides: Partial<SessionRow> & {
    commands?: number;
    bypass_reads?: number;
    tokens?: number | null;
    unknownTokens?: number;
    search_success?: number | null;
  } = {},
): SessionRow {
  const stats: Stats = {
    totals: totals(overrides),
    previous: null,
    daily: [],
    signals: {
      lat_commands_per_session: null,
      search_success: overrides.search_success ?? null,
      bypass_rate: null,
      net_tokens_saved: null,
      net_tokens_saved_reason: null,
      injected_bytes: sum(0),
    },
  };
  return {
    ...stats,
    key,
    label: key,
    rolled_up: stats,
    agent: 'claude',
    name: null,
    model: null,
    parent_session_id: null,
    children: [],
    start: '2026-01-02T10:00:00.000Z',
    end: '2026-01-02T10:01:30.000Z',
    duration_ms: 90_000,
    issues: [],
    ...overrides,
  };
}

const parent = session('sess-1', {
  name: 'Fix the parser',
  commands: 7,
  bypass_reads: 2,
  tokens: 1500,
  search_success: 0.75,
  issues: ['lat-1', 'lat-2'],
  children: ['sess-sub'],
});
const subagent = session('sess-sub', {
  parent_session_id: 'sess-1',
  commands: 3,
  tokens: null,
  duration_ms: null,
});
const summary = (sessions: SessionRow[]) =>
  ({ sessions }) as unknown as UsageSummary;

const base = {
  agent: 'claude' as const,
  session_id: 'sess-1',
  issue_ids: [],
  attribution: 'unattributed' as const,
};
const source = { path: 'transcript.jsonl', offset: 0 };
const usageRecord = (
  id: string,
  ts: string,
  fields: Record<string, unknown> = {},
) =>
  ({
    ...base,
    type: 'usage',
    id,
    ts,
    event: {
      event_id: id,
      ts,
      command: 'search',
      surface: 'cli',
      caller: 'agent',
      exit_code: 0,
      duration_ms: 12,
      section_id: null,
      error_class: null,
      result_count: 3,
      injected_bytes: null,
      query: 'secret words',
      ...fields,
    },
  }) as unknown as RawRecord;
const sessionRecord = (
  id: string,
  ts: string,
  event: Record<string, unknown>,
) =>
  ({
    ...base,
    type: 'session',
    id,
    ts,
    event: { event_id: id, session_id: 'sess-1', ts, source, ...event },
  }) as unknown as RawRecord;

const lanes = {
  command: usageRecord('cmd-1', '2026-01-02T10:00:10.000Z'),
  hook: usageRecord('hook-1', '2026-01-02T10:00:20.000Z', {
    surface: 'hook',
    command: 'hook',
    injected_bytes: 640,
  }),
  bypass: sessionRecord('byp-1', '2026-01-02T10:00:30.000Z', {
    kind: 'bypass_read',
    path: 'src/a/b.ts',
    bytes: 100,
  }),
  claim: sessionRecord('bd-1', '2026-01-02T10:00:40.000Z', {
    kind: 'bd_command',
    verb: 'claim',
    issue_id: 'lat-1',
  }),
  close: sessionRecord('bd-2', '2026-01-02T10:00:50.000Z', {
    kind: 'bd_command',
    verb: 'close',
    issue_id: 'lat-1',
  }),
  tokens: sessionRecord('tok-1', '2026-01-02T10:00:55.000Z', {
    kind: 'token_usage',
    usage: {},
  }),
};

describe('usage dashboard sessions page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: string[];
  let sessions: SessionRow[];
  let rawPages: (cursor: string | null) => RawEventsPage;
  let failSummary: string | undefined;
  let hang = false;
  const text = () => container.textContent!;
  const hrefs = () =>
    [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

  async function show(id?: string, search = '') {
    window.history.replaceState(null, '', `/_usage/sessions${search}`);
    await act(async () => root.render(createElement(SessionsPage, { id })));
    await act(async () => {});
  }
  const timelineRows = () =>
    [
      ...container.querySelectorAll('[aria-label="Session timeline"] tbody tr'),
    ].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

  beforeEach(() => {
    requests = [];
    sessions = [parent, subagent];
    failSummary = undefined;
    hang = false;
    rawPages = () => ({ records: [], next_cursor: null });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        if (hang) return new Promise<never>(() => {});
        const path = url.split('?')[0];
        if (path === '/api/usage' && failSummary)
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: failSummary }),
          };
        const body =
          path === '/api/usage/raw'
            ? rawPages(new URL(url, 'http://x').searchParams.get('cursor'))
            : summary(sessions);
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

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#The table lists sessions with all columns and nests subagents]]
  it('lists sessions with all columns and nests subagents', async () => {
    await show();
    const headers = [...container.querySelectorAll('th')].map((th) =>
      th.textContent!.replace(/[▲▼]/g, '').trim(),
    );
    for (const header of [
      'Session',
      'Agent',
      'Start',
      'Duration',
      'Lat commands',
      'Search success',
      'Bypass reads',
      'Tokens',
      'Issues',
    ])
      expect(headers).toContain(header);
    const rows = () => [...container.querySelectorAll('tbody tr')];
    expect(rows()).toHaveLength(1);
    const row = rows()[0].textContent!;
    for (const word of [
      'Fix the parser',
      'claude',
      '2026-01-02 10:00',
      '1m 30s',
      '7',
      '75%',
      '2',
      '3,000',
      'lat-1, lat-2',
    ])
      expect(row).toContain(word);
    const toggle = rows()[0].querySelector('button[aria-expanded]')!;
    await click(toggle);
    expect(rows()).toHaveLength(2);
    const child = rows()[1].textContent!;
    expect(child).toContain('sess-sub');
    expect(child.match(/unknown/g)!.length).toBeGreaterThanOrEqual(2);
  });

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#A session with more than 200 events loads every event]]
  it('loads every event of a session across pages', async () => {
    const many = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) =>
        usageRecord(
          `c-${from + i}`,
          new Date(
            Date.UTC(2026, 0, 2, 10, 0, 0) + (from + i) * 1000,
          ).toISOString(),
        ),
      );
    rawPages = (cursor) =>
      cursor === null
        ? { records: many(0, 200), next_cursor: 'next' }
        : { records: many(200, 250), next_cursor: null };
    await show('sess-1');
    const rawUrls = requests.filter((u) => u.startsWith('/api/usage/raw'));
    expect(rawUrls).toHaveLength(2);
    expect(rawUrls[0]).toContain('session=sess-1');
    expect(rawUrls[1]).toContain('cursor=next');
    expect(timelineRows()).toHaveLength(250);
    expect(text()).toContain('250 events');
  });

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#The detail timeline places each event in the right lane at the right time]]
  it('places each event in its lane at its time', async () => {
    rawPages = () => ({
      records: Object.values(lanes),
      next_cursor: null,
    });
    await show('sess-1');
    const row = (id: string) =>
      timelineRows().find((cells) => cells[1] === id)!;
    expect(row('cmd-1')[0]).toBe('Lat commands');
    expect(row('cmd-1')[3]).toBe('2026-01-02T10:00:10Z');
    expect(row('hook-1')[0]).toBe('Injected context');
    expect(row('hook-1')[3]).toBe('2026-01-02T10:00:20Z');
    expect(row('byp-1')[0]).toBe('Bypass reads');
    expect(row('byp-1')[3]).toBe('2026-01-02T10:00:30Z');
    expect(row('bd-1')[0]).toBe('bd claims and closes');
    expect(row('bd-2')[0]).toBe('bd claims and closes');
    expect(row('bd-2')[3]).toBe('2026-01-02T10:00:50Z');
    expect(
      timelineRows().find((cells) => cells[1] === 'tok-1'),
    ).toBeUndefined();
  });

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#Selecting an event shows its fields]]
  it('shows the fields of the selected event and no query text', async () => {
    rawPages = () => ({
      records: [lanes.command, lanes.bypass],
      next_cursor: null,
    });
    await show('sess-1');
    expect(container.querySelector('[aria-label="Selected event"]')).toBeNull();
    const choose = (id: string) =>
      [...container.querySelectorAll('button')].find((b) =>
        b.textContent!.includes(id),
      )!;
    await click(choose('byp-1'));
    const panel = container.querySelector('[aria-label="Selected event"]')!;
    for (const word of [
      'byp-1',
      'bypass_read',
      'src/a/b.ts',
      '2026-01-02T10:00:30',
    ])
      expect(panel.textContent).toContain(word);
    await click(choose('cmd-1'));
    const next = container.querySelector(
      '[aria-label="Selected event"]',
    )!.textContent!;
    expect(next).toContain('cmd-1');
    expect(next).toContain('search');
    expect(next).not.toContain('secret words');
    expect(next).not.toContain('src/a/b.ts');
  });

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#Links keep the filter query string]]
  it('keeps the filter query string on every link', async () => {
    const filters = '?agent=claude&issue=lat-9';
    await show(undefined, filters);
    const rowLink = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Fix the parser',
    )!;
    expect(rowLink.getAttribute('href')).toBe(
      `/_usage/sessions/sess-1${filters}`,
    );
    sessions = [parent, subagent];
    await show('sess-sub', filters);
    expect(hrefs()).toContain(`/_usage/sessions${filters}`);
    expect(hrefs()).toContain(`/_usage/sessions/sess-1${filters}`);
    await show('sess-1', filters);
    expect(hrefs()).toContain(`/_usage/issues/lat-1${filters}`);
    expect(hrefs()).toContain(`/_usage/issues/lat-2${filters}`);
    expect(hrefs()).toContain(`/_usage/sessions/sess-sub${filters}`);
  });

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#Loading and error states]]
  it('shows loading, error and empty states', async () => {
    hang = true;
    await show();
    expect(text()).toContain('Loading');
    await act(async () => root.unmount());
    root = createRoot(container);
    hang = false;
    sessions = [];
    await show();
    expect(text()).toContain('No sessions under the current filters');
    sessions = [parent];
    await show(undefined, '?agent=claude');
    expect(text()).toContain('Fix the parser');
    failSummary = 'stream broke';
    await show(undefined, '?agent=pi');
    expect(text()).toContain('Fix the parser');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'stream broke',
    );
  });

  // @lat: [[usage-dashboard-sessions#Usage Dashboard Sessions#Unknown token counts are shown]]
  it('shows the unknown token count beside the known total', async () => {
    sessions = [
      session('part', { tokens: 5, unknownTokens: 40 }),
      session('none', { tokens: null, unknownTokens: 40 }),
    ];
    await show();
    const row = (id: string) =>
      [...container.querySelectorAll('tbody tr')].find((tr) =>
        tr.textContent!.includes(id),
      )!.textContent!;
    expect(row('part')).toContain('10');
    expect(row('part')).toContain('+40 unknown');
    expect(row('none')).toContain('+40 unknown');
    expect(row('none').match(/unknown/g)!.length).toBeGreaterThanOrEqual(2);
    await show('part');
    expect(text()).toContain('tokens 10 (+40 unknown)');
    await show('none');
    expect(text()).toContain('tokens unknown');
  });
});
