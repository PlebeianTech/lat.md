// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountedSum,
  IssueRow,
  Row,
  SessionRow,
  Stats,
  Totals,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
import { IssuesPage } from '../view/src/usage/pages/issues-page';

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

interface StatsInput {
  commands: number;
  sessions?: number;
  bypass_reads?: number;
  search_success?: number | null;
  net_tokens_saved?: number | null;
  reason?: string | null;
}

function stats(input: StatsInput): Stats {
  const totals: Totals = {
    commands: input.commands,
    sessions: input.sessions ?? 1,
    searches: 0,
    zero_result_searches: 0,
    searches_unknown_results: 0,
    followed_searches: 0,
    reformulated_searches: 0,
    section_reads: 0,
    bypass_reads: input.bypass_reads ?? 0,
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
  return {
    totals,
    previous: null,
    daily: [],
    signals: {
      lat_commands_per_session: input.commands / (input.sessions ?? 1),
      search_success: input.search_success ?? null,
      bypass_rate: null,
      net_tokens_saved: input.net_tokens_saved ?? null,
      net_tokens_saved_reason: input.reason ?? null,
      injected_bytes: sum(0),
    },
  };
}

function issue(
  key: string,
  own: StatsInput,
  rolled: StatsInput,
  extra: Partial<IssueRow> = {},
): IssueRow {
  return {
    ...stats(own),
    key,
    label: extra.label ?? key,
    rolled_up: stats(rolled),
    status: 'open',
    parent: null,
    issue_type: 'task',
    ...extra,
  };
}

// lat-e (epic) > lat-e.1 (sub-epic) > lat-e.1.1 (leaf); lat-e.2 (leaf); lat-x (top level).
// lat-e.1 and lat-e.2 share events, so the rolled-up sums need not add up.
const epic = issue(
  'lat-e',
  { commands: 1 },
  { commands: 10, sessions: 3, net_tokens_saved: -42 },
  { label: 'Big epic', issue_type: 'epic' },
);
const subEpic = issue(
  'lat-e.1',
  { commands: 2 },
  { commands: 6, search_success: 0.5, bypass_reads: 4 },
  { label: 'Sub epic', issue_type: 'epic', parent: 'lat-e' },
);
const leaf = issue(
  'lat-e.1.1',
  { commands: 4, net_tokens_saved: 100 },
  { commands: 4, net_tokens_saved: 100 },
  { label: 'Leaf work', status: 'closed', parent: 'lat-e.1' },
);
const sibling = issue(
  'lat-e.2',
  { commands: 3 },
  { commands: 3 },
  { label: 'Second leaf', parent: 'lat-e' },
);
const other = issue(
  'lat-x',
  { commands: 8 },
  { commands: 8 },
  { label: 'Other thing' },
);

const unattributed: Row = {
  key: 'unattributed',
  label: 'Unattributed',
  ...stats({
    commands: 5,
    sessions: 2,
    net_tokens_saved: null,
    reason: 'no estimate',
  }),
};

function session(key: string, issues: string[]): SessionRow {
  return {
    ...stats({ commands: 1 }),
    key,
    label: key,
    rolled_up: stats({ commands: 1 }),
    agent: 'claude',
    name: null,
    model: null,
    parent_session_id: null,
    children: [],
    start: null,
    end: null,
    duration_ms: null,
    issues,
  };
}

describe('usage dashboard issues page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let issues: IssueRow[];
  let sessions: SessionRow[];
  let extensions: Record<string, unknown>;
  let failSummary: string | undefined;
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
  const rowOf = (id: string) =>
    rows().find((tr) => tr.textContent!.includes(id))!;
  const cells = (tr: Element) =>
    [...tr.querySelectorAll('td')].map((td) =>
      td.textContent!.replace(/^[▸▾]/, ''),
    );
  const headers = () =>
    [...container.querySelectorAll('[data-entity-table] th')].map((th) =>
      th.textContent!.replace(/[▲▼]/g, '').trim(),
    );
  const expand = async (name: string) =>
    click(container.querySelector(`button[aria-label="Expand ${name}"]`)!);

  async function show(id?: string, search = '') {
    window.history.replaceState(null, '', `/_usage/issues${search}`);
    await act(async () => root.render(createElement(IssuesPage, { id })));
    await act(async () => {});
  }

  beforeEach(() => {
    issues = [epic, subEpic, leaf, sibling, other];
    sessions = [
      session('sess-a', ['lat-e.1.1']),
      session('sess-b', ['lat-x']),
      session('sess-c', ['lat-e']),
    ];
    extensions = { savings: { method_version: 'v7' } };
    failSummary = undefined;
    hang = false;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (hang) return new Promise<never>(() => {});
        if (failSummary)
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: failSummary }),
          };
        const body = { issues, sessions, unattributed, extensions } as unknown;
        return {
          ok: true,
          status: 200,
          json: async () => body as UsageSummary,
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

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#The tree nests epics, sub-epics and leaves with own and rolled-up totals]]
  it('nests epics, sub-epics and leaves with own and rolled-up totals', async () => {
    await show();
    for (const header of [
      'Issue',
      'Type',
      'Status',
      'Lat commands',
      'Lat commands (rolled up)',
      'Search success',
      'Search success (rolled up)',
      'Bypass reads',
      'Bypass reads (rolled up)',
      'Net tokens saved',
      'Net tokens saved (rolled up)',
      'Sessions',
      'Sessions (rolled up)',
    ])
      expect(headers()).toContain(header);
    // Only top-level issues show at first, the most active (rolled up) first.
    expect(rows().map((tr) => cells(tr)[0])).toEqual([
      'lat-e Big epic',
      'lat-x Other thing',
    ]);
    const column = (name: string) => headers().indexOf(name);
    const epicCells = cells(rowOf('lat-e Big'));
    expect(epicCells[column('Lat commands')]).toBe('1');
    expect(epicCells[column('Lat commands (rolled up)')]).toBe('10');
    expect(epicCells[column('Sessions (rolled up)')]).toBe('3');
    expect(epicCells[column('Net tokens saved (rolled up)')]).toBe('-42');
    expect(epicCells[column('Net tokens saved')]).toBe('unknown');
    await expand('lat-e Big epic');
    expect(rows().map((tr) => cells(tr)[0])).toContain('lat-e.1 Sub epic');
    expect(rows().map((tr) => cells(tr)[0])).toContain('lat-e.2 Second leaf');
    expect(rows().map((tr) => cells(tr)[0])).not.toContain(
      'lat-e.1.1 Leaf work',
    );
    await expand('lat-e.1 Sub epic');
    const leafCells = cells(rowOf('lat-e.1.1'));
    expect(leafCells[column('Status')]).toBe('closed');
    expect(leafCells[column('Net tokens saved')]).toBe('100');
    const subCells = cells(rowOf('lat-e.1 Sub'));
    expect(subCells[column('Lat commands')]).toBe('2');
    expect(subCells[column('Lat commands (rolled up)')]).toBe('6');
    expect(subCells[column('Search success (rolled up)')]).toBe('50%');
    expect(subCells[column('Bypass reads (rolled up)')]).toBe('4');
    expect(text()).toContain('correlation, not cause, method v7');
    expect(container.querySelector('tfoot')).toBeNull();
    expect(text()).not.toMatch(/total/i);
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#The tree nests epics, sub-epics and leaves with own and rolled-up totals]]
  it('nests by the bd parent when ids are not dotted', async () => {
    issues = [
      issue('lat-e', { commands: 1 }, { commands: 5 }),
      issue('lat-q', { commands: 4 }, { commands: 4 }, { parent: 'lat-e' }),
      issue('lat-o', { commands: 2 }, { commands: 2 }, { parent: 'lat-gone' }),
    ];
    sessions = [session('sess-q', ['lat-q'])];
    await show();
    expect(rows().map((tr) => cells(tr)[0])).toEqual(['lat-e', 'lat-o']);
    await expand('lat-e');
    expect(rows().map((tr) => cells(tr)[0])).toContain('lat-q');
    await show('lat-e');
    expect(
      container.querySelector('[aria-label="Child issues"]')!.textContent,
    ).toBe('lat-q');
    expect(
      container.querySelector('[aria-label="Sessions"]')!.textContent,
    ).toContain('sess-q');
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#The tree nests epics, sub-epics and leaves with own and rolled-up totals]]
  it('survives a self-parent', async () => {
    issues = [
      issue('lat-s', { commands: 1 }, { commands: 1 }, { parent: 'lat-s' }),
    ];
    await show();
    expect(rows().map((tr) => cells(tr)[0])).toEqual(['lat-s']);
    await show('lat-s');
    expect(text()).toContain('lat-s');
    expect(container.querySelector('[aria-label="Child issues"]')).toBeNull();
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#The tree nests epics, sub-epics and leaves with own and rolled-up totals]]
  it('keeps every member of a parent cycle visible', async () => {
    issues = [
      issue('lat-a', { commands: 1 }, { commands: 1 }, { parent: 'lat-b' }),
      issue('lat-b', { commands: 2 }, { commands: 2 }, { parent: 'lat-a' }),
    ];
    sessions = [session('sess-b', ['lat-b'])];
    await show();
    // lat-a is cut loose; lat-b sits under it.
    expect(rows().map((tr) => cells(tr)[0])).toEqual(['lat-a']);
    await expand('lat-a');
    expect(rows().map((tr) => cells(tr)[0])).toEqual(['lat-a', 'lat-b']);
    await show('lat-a');
    expect(
      container.querySelector('[aria-label="Child issues"]')!.textContent,
    ).toBe('lat-b');
    expect(
      container.querySelector('[aria-label="Sessions"]')!.textContent,
    ).toContain('sess-b');
    await show('lat-b');
    expect(text()).toContain('lat-b');
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#Unknown values are shown as unknown]]
  it('shows only the plain label when the savings extension has no version', async () => {
    extensions = { savings: { error: 'broke' } };
    await show();
    expect(text()).toContain('correlation, not cause');
    expect(text()).not.toContain('method');
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#The unattributed row shows its totals from the summary]]
  it('shows the unattributed row with its totals from the summary', async () => {
    await show();
    const region = container.querySelector(
      '[aria-label="Unattributed activity"]',
    )!;
    const row = region.querySelector('tbody tr')!.textContent!;
    expect(row).toContain('Unattributed');
    expect(row).toContain('5');
    expect(row).toContain('unknown');
    // The issue rows sum to more than 5; the row is not their difference.
    expect(region.compareDocumentPosition(rows()[0]) & 4).toBeTruthy();
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#The detail view shows signals, children and sessions]]
  it('shows signals, children and sessions on the detail view', async () => {
    await show('lat-e');
    expect(text()).toContain('Issues');
    expect(text()).toContain('Big epic');
    const signals = container.querySelector('[aria-label="Health signals"]')!;
    for (const word of [
      'Lat commands per session',
      'Search success',
      'Bypass rate',
      'Net tokens saved',
      '-42',
      'correlation, not cause, method v7',
    ])
      expect(signals.textContent).toContain(word);
    const children = container.querySelector('[aria-label="Child issues"]')!;
    expect(children.textContent).toContain('lat-e.1');
    expect(children.textContent).toContain('lat-e.2');
    expect(children.textContent).not.toContain('lat-e.1.1');
    const worked = container.querySelector('[aria-label="Sessions"]')!;
    expect(worked.textContent).toContain('sess-a');
    expect(worked.textContent).toContain('sess-c');
    expect(worked.textContent).not.toContain('sess-b');
    await show('lat-x');
    expect(
      container.querySelector('[aria-label="Sessions"]')!.textContent,
    ).toContain('sess-b');
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#Unknown values are shown as unknown]]
  it('shows unknown net tokens saved with its reason, never 0', async () => {
    issues = [
      issue(
        'lat-u',
        { commands: 2, net_tokens_saved: null, reason: 'no baseline' },
        { commands: 2, net_tokens_saved: null, reason: 'no baseline' },
      ),
    ];
    await show('lat-u');
    const signals = container.querySelector(
      '[aria-label="Health signals"]',
    )!.textContent!;
    expect(signals).toContain('unknown');
    expect(signals).toContain('no baseline');
    expect(signals).not.toMatch(/Net tokens saved\s*0/);
    await show();
    expect(
      container.querySelector('[aria-label="Unattributed activity"]')!
        .textContent,
    ).toContain('unknown (no estimate)');
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#Links keep the filter query string]]
  it('keeps the filter query string on every link', async () => {
    const filters = '?agent=claude&session=s-1';
    await show(undefined, filters);
    const rowLink = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'lat-x Other thing',
    )!;
    expect(rowLink.getAttribute('href')).toBe(`/_usage/issues/lat-x${filters}`);
    await show('lat-e', filters);
    expect(hrefs()).toContain(`/_usage/issues${filters}`);
    expect(hrefs()).toContain(`/_usage/issues/lat-e.1${filters}`);
    expect(hrefs()).toContain(`/_usage/sessions/sess-a${filters}`);
  });

  // @lat: [[usage-dashboard-issues#Usage Dashboard Issues#Loading and error states]]
  it('shows loading, error and empty states', async () => {
    hang = true;
    await show();
    expect(text()).toContain('Loading');
    await act(async () => root.unmount());
    root = createRoot(container);
    hang = false;
    issues = [];
    await show();
    expect(text()).toContain('No issues under the current filters');
    issues = [other];
    await show(undefined, '?agent=claude');
    expect(text()).toContain('lat-x Other thing');
    failSummary = 'stream broke';
    await show(undefined, '?agent=pi');
    expect(text()).toContain('lat-x Other thing');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'stream broke',
    );
  });
});
