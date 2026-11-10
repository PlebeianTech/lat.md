// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentRow,
  SectionRow,
  UsageSummary,
} from '../src/fork/usage/aggregate-types';
import type { KnowledgeBreakdown } from '../src/fork/usage/graph-snapshot';
import type { SectionScorecard } from '../src/fork/usage/section-scorecard';
import { KnowledgePage } from '../view/src/usage/pages/knowledge-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

function section(
  key: string,
  reads: number,
  extra: Partial<SectionRow> = {},
): SectionRow {
  return {
    key,
    label: key,
    document: 'cli.md',
    reads,
    reads_by_day: [
      { day: '2026-01-01', reads: 1 },
      { day: '2026-01-02', reads: reads - 1 },
    ],
    queries: [],
    issues: [],
    ...extra,
  } as unknown as SectionRow;
}

const detailId = 'cli#CLI#Search';
const sections: SectionRow[] = Array.from({ length: 22 }, (_, i) =>
  section(i === 0 ? detailId : `cli#CLI#Section ${i}`, 22 - i, {
    queries: i === 0 ? [{ query: 'how to search', count: 4 }] : [],
    issues: i === 0 ? ['lat-1', 'lat-2'] : [],
  }),
);

const knowledge: KnowledgeBreakdown = {
  snapshot: {
    git_head: 'abc1234def',
    sections: [],
    documents: [],
    code_ref_edges: null,
    code_ref_edges_reason: null,
    symbol_ref_edges: [],
  },
  snapshot_reason: null,
  unavailable_heads: [],
  never_read_sections: [
    { id: 'fork#Fork#Unread', document: 'fork.md', bytes: 100, hash: 'h' },
    { id: 'fork#Fork#Also unread', document: 'fork.md', bytes: 50, hash: 'g' },
  ],
  documents: [
    { path: 'cli.md', bytes: 8000, reads: 40, sections_read: 3 },
    { path: 'fork.md', bytes: 2000, reads: 10, sections_read: 1 },
    { path: 'big-pale.md', bytes: 16000, reads: 0, sections_read: 0 },
  ],
};

const scorecard: SectionScorecard = {
  unavailable_heads: [],
  sections: [
    {
      section_id: detailId,
      expected: 10,
      reached: 5,
      reach: 0.5,
      outcomes: {} as never,
      main_miss: null,
      suggested_fix: null,
      daily: [
        { day: '2026-01-01', expected: 4, reached: 1, reach: 0.25 },
        { day: '2026-01-02', expected: 0, reached: 0, reach: null },
        { day: '2026-01-03', expected: 6, reached: 4, reach: 0.75 },
      ],
      change_markers: [{ git_head: 'abc1234def', day: '2026-01-02' }],
      renamed_from: 'cli#CLI#Old search',
      ends_at_head: null,
    },
  ],
};

describe('usage dashboard knowledge page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let extensions: Record<string, unknown>;
  const text = () => container.textContent!;
  const hrefs = () =>
    [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));

  async function show(id?: string, searchString = '') {
    window.history.replaceState(null, '', `/_usage/knowledge${searchString}`);
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(KnowledgePage, { id })));
    await act(async () => {});
  }

  beforeEach(() => {
    extensions = { knowledge, section_scorecard: scorecard };
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            sections,
            documents: [] as DocumentRow[],
            extensions,
          }) as unknown as UsageSummary,
      })),
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

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#The top 20 list and the never-read count and list render]]
  it('lists the top 20 sections and the never-read sections', async () => {
    await show();
    const list = container.querySelector(
      '[role="group"][aria-label="Most-read sections"]',
    )!;
    expect(list.querySelectorAll('tbody tr')).toHaveLength(20);
    expect(list.textContent).not.toContain('Section 21');
    expect(text()).toContain('2 never-read sections');
    const details = container.querySelector('details')!;
    expect(details.textContent).toContain('fork#Fork#Unread');
    expect(details.textContent).toContain('fork#Fork#Also unread');
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#The map sizes blocks by bytes and shades them by reads]]
  it('sizes map blocks by bytes and shades them by reads', async () => {
    await show();
    const map = container.querySelector(
      '[role="group"][aria-label="Knowledge map"]',
    )!;
    expect(map.querySelector('table')).not.toBeNull();
    const block = (path: string) =>
      map.querySelector<SVGRectElement>(`rect[data-document="${path}"]`)!;
    const area = (path: string) =>
      Number(block(path).getAttribute('width')) *
      Number(block(path).getAttribute('height'));
    expect(area('big-pale.md') / area('cli.md')).toBeCloseTo(2, 2);
    expect(area('cli.md') / area('fork.md')).toBeCloseTo(4, 2);
    expect(block('big-pale.md').getAttribute('data-bytes')).toBe('16000');
    expect(block('big-pale.md').style.fill).toBe('var(--heat-1)');
    expect(block('cli.md').style.fill).toBe('var(--heat-5)');
    expect(block('fork.md').style.fill).toBe('var(--heat-2)');
    expect(map.querySelector('svg')!.getAttribute('viewBox')).toBeTruthy();
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#The detail view shows reads over time, leading queries and reading issues]]
  it('shows reads over time, leading queries and reading issues', async () => {
    await show(detailId);
    expect(text()).toContain('Knowledge');
    expect(container.querySelector('h1')!.textContent).toBe(detailId);
    expect(
      container.querySelector('[role="img"][aria-label^="Reads per day"]'),
    ).not.toBeNull();
    expect(text()).toContain('how to search');
    expect(text()).toContain('lat-1');
    expect(text()).toContain('lat-2');
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#The section detail shows the reach series and lists content changes]]
  it('shows the reach series and lists content changes', async () => {
    await show(detailId);
    expect(
      container.querySelector('[role="img"][aria-label^="Reach per day"]'),
    ).not.toBeNull();
    const markers = container.querySelector('[aria-label="Content changes"]')!;
    expect(markers.querySelectorAll('li')).toHaveLength(1);
    expect(markers.textContent).toContain('abc1234');
    expect(markers.textContent).toContain('2026-01-02');
    expect(text()).toContain('cli#CLI#Old search');
    expect(text()).toContain('of 10 times expected.');
    expect(text()).not.toContain('expected reads');
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#Missing or failed extensions show unknown with a reason]]
  it('shows unknown with a reason when extensions are missing or failed', async () => {
    extensions = { knowledge: { error: 'snapshot broke' } };
    await show();
    expect(text()).toContain('unknown (snapshot broke)');
    expect(text()).not.toContain('0 never-read');
    extensions = {
      knowledge: {
        ...knowledge,
        snapshot: null,
        snapshot_reason: 'no worktree',
      },
    };
    await show();
    expect(text()).toContain('unknown (no worktree)');
    await show(detailId);
    expect(text()).toContain('unknown (the section scorecard is missing');
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#Links keep the filter query string]]
  it('keeps the filter query string in links', async () => {
    const search = '?agent=claude&from=2026-01-01';
    await show(undefined, search);
    const list = hrefs();
    const suffix = list
      .find((href) => href!.startsWith('/_usage/knowledge/'))!
      .split('?')[1];
    expect(suffix).toContain('agent=claude');
    expect(suffix).toContain('from=2026-01-01');
    expect(list).toContain(
      `/_usage/knowledge/${encodeURIComponent('fork#Fork#Unread')}?${suffix}`,
    );
    await show(detailId, search);
    const detail = hrefs();
    expect(detail).toContain(`/_usage/knowledge?${suffix}`);
    expect(detail).toContain(`/_usage/queries/how%20to%20search?${suffix}`);
    expect(detail).toContain(`/_usage/issues/lat-1?${suffix}`);
    expect(detail).toContain(
      `/_usage/knowledge/${encodeURIComponent('cli#CLI#Old search')}?${suffix}`,
    );
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#A never-read section opens a detail view from the scorecard alone]]
  it('opens the detail of a never-read section without a section row', async () => {
    extensions = {
      knowledge,
      section_scorecard: {
        ...scorecard,
        sections: [
          { ...scorecard.sections[0], section_id: 'fork#Fork#Unread' },
        ],
      },
    };
    await show('fork#Fork#Unread');
    expect(container.querySelector('h1')!.textContent).toBe('fork#Fork#Unread');
    expect(text()).toContain('no reads');
    expect(
      container.querySelector('[role="img"][aria-label^="Reach per day"]'),
    ).not.toBeNull();
    expect(text()).toContain('abc1234');
  });

  // @lat: [[usage-dashboard-knowledge#Usage Dashboard Knowledge#Unavailable git heads are shown as a note]]
  it('notes the git heads that could not be snapshotted', async () => {
    const unavailable_heads = [
      { git_head: 'deadbeef00', reason: 'no worktree' },
    ];
    extensions = {
      knowledge: { ...knowledge, unavailable_heads },
      section_scorecard: { ...scorecard, unavailable_heads },
    };
    await show();
    expect(text()).toContain(
      'Snapshots unavailable for 1 git head: deadbee (no worktree)',
    );
    await show(detailId);
    expect(text()).toContain(
      'Snapshots unavailable for 1 git head: deadbee (no worktree)',
    );
  });
});
