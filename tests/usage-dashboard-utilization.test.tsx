// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageSummary } from '../src/fork/usage/aggregate-types';
import type { Finding, FindingsResult } from '../src/fork/usage/findings';
import type {
  MissConsequences,
  CounterEffort,
  GroupResult,
} from '../src/fork/usage/miss-consequences';
import type {
  MissedKnowledge,
  ReachStats,
  SessionReach,
} from '../src/fork/usage/missed-knowledge';
import type { SectionScorecard } from '../src/fork/usage/section-scorecard';

const { useUsageData } = vi.hoisted(() => ({ useUsageData: vi.fn() }));
vi.mock('../view/src/usage/use-usage-data', () => ({ useUsageData }));
import { UtilizationPage } from '../view/src/usage/pages/utilization-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const outcomes = (extra: Record<string, number> = {}) => ({
  reached: 0,
  'read-late': 0,
  bypassed: 0,
  'found-not-opened': 0,
  'searched-not-found': 0,
  'never-consulted': 0,
  ...extra,
});

function stats(extra: Partial<ReachStats> = {}): ReachStats {
  return {
    sessions: 2,
    measured_sessions: 2,
    not_captured_sessions: 0,
    no_edit_sessions: 0,
    sessions_with_miss: 1,
    expected_sections: 10,
    reached: 6,
    outcomes: outcomes({ reached: 6, bypassed: 4 }),
    reach: 0.6,
    reach_reason: null,
    no_coverage: { new_file: 0, undocumented: 0, unclassified: 0 },
    ...extra,
  };
}

function sessionReach(
  id: string,
  issue_types: string[],
  extra: Partial<SessionReach> = {},
): SessionReach {
  return {
    session_id: id,
    agent: 'claude',
    start: null,
    git_head: null,
    status: 'measured',
    reason: null,
    issue_ids: ['lat-1'],
    issue_types,
    expected_sections: 4,
    reached: 3,
    outcomes: outcomes({ reached: 3, bypassed: 1 }),
    reach: 0.75,
    reach_reason: null,
    had_a_miss: true,
    no_coverage: { new_file: 0, undocumented: 0, unclassified: 0 },
    ...extra,
  };
}

const missedKnowledge = {
  method_version: 7,
  notes: {
    inferred_not_intended: 'inferred note',
    measures_existing_documented_code: 'existing note',
  },
  totals: stats(),
  previous: null,
  daily: [],
  by_issue_type: [
    { key: 'bug', ...stats({ reach: 0.5 }) },
    { key: 'epic', ...stats({ reach: 0.9 }) },
    {
      key: 'untyped',
      ...stats({ reach: null, reach_reason: 'no expected sections' }),
    },
  ],
  by_agent: [],
  by_issue: [],
  sessions: [
    sessionReach('sess one', ['epic'], { issue_ids: ['lat-9'] }),
    sessionReach('sess-shared', ['bug', 'feature']),
    sessionReach('sess-none', [], {
      status: 'not_captured',
      reason: 'no snapshot',
      reach: null,
      reach_reason: 'no snapshot',
      expected_sections: 0,
      reached: 0,
    }),
  ],
  records: [],
  undocumented_files: [],
  unjoinable_events: 0,
} as unknown as MissedKnowledge;

const scorecard: SectionScorecard = {
  unavailable_heads: [],
  sections: [
    {
      section_id: 'cli#CLI#Few',
      expected: 10,
      reached: 9,
      reach: 0.9,
      outcomes: outcomes(),
      main_miss: 'bypassed',
      suggested_fix: 'split the file',
      daily: [{ day: '2026-01-01', expected: 10, reached: 9, reach: 0.9 }],
      change_markers: [],
      renamed_from: null,
      ends_at_head: null,
    },
    {
      section_id: 'cli#CLI#Many',
      expected: 10,
      reached: 2,
      reach: 0.2,
      outcomes: outcomes(),
      main_miss: 'searched-not-found',
      suggested_fix: 'reword the title',
      daily: [{ day: '2026-01-01', expected: 10, reached: 2, reach: 0.2 }],
      change_markers: [],
      renamed_from: null,
      ends_at_head: null,
    },
  ],
};

const counter = (median: number | null): CounterEffort => ({
  median,
  sample: 3,
  issues_with_unknown: median === null ? 0 : 1,
  unknown_issues: 2,
  reason: median === null ? 'no issue has known tokens' : null,
});
const rate = (count: number, sample: number) => ({
  sample,
  count,
  rate: sample === 0 ? null : count / sample,
  reason: sample === 0 ? 'no_eligible_sample' : null,
  left_out_window_not_complete: 1,
  left_out_other: {},
});
const group = (
  sessions: number,
  median: number | null,
  durationMs: number | null = null,
): GroupResult => ({
  sessions,
  issues: sessions,
  rework: rate(1, sessions),
  failed_test_runs: {
    sample: sessions,
    total: 3,
    per_session: 1.5,
    sessions_with_a_failure: 1,
    share_with_a_failure: 0.5,
    reason: null,
    unknown_sessions: 2,
  },
  follow_up_bugs: { ...rate(0, 0), left_out_other: { never_closed: 4 } },
  reopened_issues: rate(1, sessions),
  effort: {
    issues: sessions,
    tokens: { input: counter(median) } as never,
    duration_ms_median: durationMs,
    duration_sample: durationMs === null ? 0 : 4,
    duration_unknown: 1,
    duration_reason: durationMs === null ? 'no_eligible_sample' : null,
  },
});

const consequences = {
  method_version: 3,
  label: 'correlation, not cause',
  windows: { rework_days: 3, follow_up_bug_days: 14, reopen_days: 14 },
  reopen_limit: { retention_days: 7, note: 'retention note' },
  groups: {
    reached_everything: group(11, 100, 754_000),
    had_a_miss: group(22, null),
  },
  sessions_without_expected_sections: 0,
  last_event: null,
} as unknown as MissConsequences;

const finding = (extra: Partial<Finding>): Finding => ({
  kind: 'uncovered-hot-file',
  id: 'uncovered-hot-file:src/a b.ts',
  subject: 'src/a b.ts',
  count: 5,
  sessions: 2,
  first_seen: null,
  last_seen: null,
  daily: [],
  evidence: [],
  suggestion: null,
  ...extra,
});
const findings: Finding[] = [
  finding({}),
  finding({
    kind: 'search-miss',
    id: 'search-miss:how to x',
    subject: 'how to x',
    expected_section_id: 'cli#CLI#Search & find',
  }),
  finding({ kind: 'empty-search', id: 'empty-search:other', subject: 'other' }),
];

describe('usage dashboard utilization page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let extensions: Record<string, unknown>;
  let findingsResult: FindingsResult;
  const text = () => container.textContent!;
  const hrefs = () =>
    [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));

  async function show(search = '') {
    window.history.replaceState(null, '', `/_usage/utilization${search}`);
    await act(async () => root.render(createElement(UtilizationPage, {})));
  }

  beforeEach(() => {
    extensions = {
      missed_knowledge: missedKnowledge,
      section_scorecard: scorecard,
      miss_consequences: consequences,
    };
    findingsResult = { findings, errors: [] };
    useUsageData.mockReset();
    useUsageData.mockImplementation((path: string) =>
      path === '/api/usage/findings'
        ? { data: findingsResult, error: undefined, loading: false }
        : {
            data: { extensions } as unknown as UsageSummary,
            error: undefined,
            loading: false,
          },
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#Reach renders per issue type]]
  it('renders reach per issue type, unknown with its reason', async () => {
    await show();
    const chart = container.querySelector(
      '[role="group"][aria-label="Knowledge reach by issue type"]',
    )!;
    expect(chart.textContent).toContain('epic');
    expect(chart.textContent).toContain('90');
    expect(chart.textContent).toContain('bug');
    expect(text()).toContain('untyped: unknown (no expected sections)');
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#Outcomes stack per issue type]]
  it('stacks the miss outcomes per issue type', async () => {
    await show();
    const chart = container.querySelector(
      '[role="group"][aria-label="Miss outcomes by issue type"]',
    )!;
    expect(chart.textContent).toContain('epic');
    expect(chart.textContent).toContain('bypassed');
    expect(chart.textContent).toContain('never-consulted');
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#Findings link to their detail]]
  it('links uncovered files and search misses to their findings', async () => {
    await show('?agent=claude');
    expect(hrefs()).toContain(
      `/_usage/findings/${encodeURIComponent('uncovered-hot-file:src/a b.ts')}?agent=claude`,
    );
    expect(hrefs()).toContain(
      `/_usage/findings/${encodeURIComponent('search-miss:how to x')}?agent=claude`,
    );
    expect(hrefs()).toContain(
      `/_usage/knowledge/${encodeURIComponent('cli#CLI#Search & find')}?agent=claude`,
    );
    expect(text()).not.toContain('empty-search');
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#Findings link to their detail]]
  it('ranks a list by sessions before count', async () => {
    findingsResult = {
      findings: [
        finding({ id: 'uncovered-hot-file:many', subject: 'many', count: 50 }),
        finding({
          id: 'uncovered-hot-file:wide',
          subject: 'wide',
          count: 2,
          sessions: 9,
        }),
      ],
      errors: [],
    };
    await show();
    const items = [
      ...container.querySelectorAll('[aria-label="Top undocumented files"] li'),
    ].map((li) => li.textContent);
    expect(items[0]).toContain('wide');
    expect(items[1]).toContain('many');
  });

  it('says when a detector failed', async () => {
    findingsResult = {
      findings: [],
      errors: [{ detector: 'uncovered-hot-file', message: 'boom' }],
    };
    await show();
    expect(text()).toContain('uncovered-hot-file');
    expect(text()).toContain('boom');
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#The session table links to session detail]]
  it('lists sessions with their issue types and links to detail', async () => {
    await show('?from=2026-01-01');
    const table = container.querySelector(
      '[role="region"][aria-label="Sessions"]',
    )!;
    const rows = [...table.querySelectorAll('tbody tr')];
    const epic = rows.find((r) => r.textContent!.includes('sess one'))!;
    expect(epic.querySelectorAll('td')[1].textContent).toBe('epic');
    const shared = rows.find((r) => r.textContent!.includes('sess-shared'))!;
    expect(shared.querySelectorAll('td')[1].textContent).toBe('bug, feature');
    const unmeasured = rows.find((r) => r.textContent!.includes('sess-none'))!;
    expect(unmeasured.textContent).toContain('unknown');
    expect(unmeasured.textContent).toContain('no snapshot');
    expect(hrefs()).toContain(
      `/_usage/sessions/${encodeURIComponent('sess one')}?from=2026-01-01`,
    );
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#The page says outcomes are inferred]]
  it('labels outcomes as inferred and shows the method version', async () => {
    await show();
    expect(text()).toMatch(/inferred from behaviour/i);
    expect(text()).toContain('method version 7');
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#The scorecard sorts by misses]]
  it('sorts the section scorecard by misses and shows the fix', async () => {
    await show('?to=2026-02-01');
    const table = container.querySelector(
      '[role="region"][aria-label="Sections to fix first"]',
    )!;
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows[0].textContent).toContain('cli#CLI#Many');
    expect(rows[0].textContent).toContain('reword the title');
    expect(rows[0].textContent).toContain('searched-not-found');
    expect(rows[1].textContent).toContain('cli#CLI#Few');
    expect(hrefs()).toContain(
      `/_usage/knowledge/${encodeURIComponent('cli#CLI#Many')}?to=2026-02-01`,
    );
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#The cost comparison shows both groups]]
  it('compares both groups with sample sizes and the correlation label', async () => {
    await show();
    const block = container.querySelector(
      '[role="group"][aria-label="Did misses cost anything"]',
    )!;
    expect(block.textContent).toContain('Reached everything');
    expect(block.textContent).toContain('Had a miss');
    expect(block.textContent).toContain('n=11');
    expect(block.textContent).toContain('n=22');
    expect(block.textContent).toContain('correlation, not cause');
    expect(block.textContent).toContain('method version 3');
    expect(block.textContent).toContain('unknown (no issue has known tokens)');
    expect(block.textContent).toContain(
      'unknown (no eligible session or issue in the sample) (n=0; left out: 1 window not complete, 4 issue never closed)',
    );
    expect(block.textContent).toContain(
      '9% (1 of 11; left out: 1 window not complete)',
    );
    expect(block.textContent).toContain('2 sessions unknown');
    expect(block.textContent).toContain('retention note');
    expect(block.textContent).toContain(
      '100 (n=3) +2 unknown; 1 partly unknown',
    );
    const durations = [...block.querySelectorAll('tr')]
      .find((tr) => tr.textContent!.startsWith('Median duration per issue'))!
      .querySelectorAll('td');
    expect(durations[0].textContent).toBe('12m 34s (n=4) +1 unknown');
    expect(durations[1].textContent).toBe(
      'unknown (no eligible session or issue in the sample) (n=0) +1 unknown',
    );
  });

  // @lat: [[usage-dashboard-utilization#Usage Dashboard Utilization#Missing data shows unknown]]
  it('shows unknown with a reason for a missing or failed extension', async () => {
    extensions = {
      missed_knowledge: { error: 'index failed' },
      miss_consequences: { error: 'no bd' },
    };
    await show();
    expect(text()).toContain('unknown (index failed)');
    expect(text()).toContain('unknown (no bd)');
    expect(text()).toContain(
      'unknown (the section scorecard is missing from the summary)',
    );
  });

  it('shows an error and keeps loading state', async () => {
    useUsageData.mockImplementation(() => ({
      data: undefined,
      error: new Error('offline'),
      loading: true,
    }));
    await show();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'offline',
    );
    expect(text()).toContain('Loading');
  });
});
