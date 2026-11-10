// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FacetField,
  RawEventsPage,
  RawFacet,
  RawRecord,
} from '../src/fork/usage/event-index';
import { ExplorePage } from '../view/src/usage/pages/explore-page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const streams: FakeEventSource[] = [];
class FakeEventSource {
  listeners: Record<string, () => void> = {};
  constructor(readonly url: string) {
    streams.push(this);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners[name] = listener;
  }
  close() {}
}

const base = { issue_ids: [], attribution: 'unattributed' as const };
const usage = (
  id: string,
  ts: string,
  fields: Record<string, unknown>,
): RawRecord =>
  ({
    ...base,
    type: 'usage',
    id,
    ts,
    agent: (fields.agent as string | null) ?? null,
    session_id: (fields.session_id as string | null) ?? null,
    event: {
      event_id: id,
      ts,
      command: 'search',
      surface: 'cli',
      caller: 'agent',
      section_id: null,
      exit_code: 0,
      error_class: null,
      ...fields,
    },
  }) as unknown as RawRecord;

const u1 = usage('u1', '2026-01-05T10:04:00.000Z', {
  agent: 'claude',
  session_id: 's1',
});
const u2 = usage('u2', '2026-01-05T10:03:00.000Z', {
  agent: 'claude',
  session_id: 's1',
  command: 'section',
  section_id: 'cli#CLI#Search',
});
const u3 = usage('u3', '2026-01-05T10:02:00.000Z', {
  agent: 'codex',
  session_id: 's2',
  command: 'section',
  section_id: 'cli#CLI#Check',
  exit_code: 1,
  error_class: 'not_found',
});
const u4 = usage('u4', '2026-01-05T10:01:00.000Z', {
  agent: null,
  session_id: 's2',
  command: 'check',
});
const k1 = {
  ...base,
  type: 'session',
  id: 'k1',
  ts: '2026-01-05T10:00:00.000Z',
  agent: 'claude',
  session_id: 's1',
  event: {
    event_id: 'k1',
    session_id: 's1',
    ts: '2026-01-05T10:00:00.000Z',
    source: { path: '/x/s1.jsonl', offset: 10 },
    kind: 'tool_call',
    tool: {
      name: 'Bash',
      action: 'shell',
      path: null,
      bytes: null,
      shell: { exit_code: { value: 0 }, command: 'rm -rf SECRET-COMMAND' },
    },
  },
} as unknown as RawRecord;
const all = [u1, u2, u3, u4, k1];

function valueOf(r: RawRecord, field: FacetField) {
  if (field === 'agent' || field === 'session_id') return r[field];
  if (r.type !== 'usage') return undefined;
  return (r.event as unknown as Record<string, string | number | null>)[field];
}
function facetOf(records: RawRecord[], field: FacetField): RawFacet {
  const counts = new Map<string | number, number>();
  let missing = 0;
  let unknown = 0;
  let lacking = 0;
  for (const r of records) {
    const v = valueOf(r, field);
    const reasons = (
      r.event as unknown as { unknown_reasons?: Record<string, string> }
    ).unknown_reasons;
    if (v === undefined) lacking++;
    else if (v === null) {
      if (reasons?.[field]) unknown++;
      else missing++;
    } else counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return {
    field,
    values: [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    missing,
    unknown,
    lacking,
  };
}

describe('usage dashboard explore page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let events: RawRecord[];
  let pageSize: number;
  let overlap: boolean;
  let failRaw: string | undefined;
  let hangEvents = false;
  let holdCursor: Promise<void> | undefined;
  let requests: string[];
  const text = () => container.textContent!;
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const rowIds = () =>
    [...container.querySelectorAll('[data-event-table] tbody tr')].map(
      (tr) => tr.getAttribute('data-event-id')!,
    );
  const loadMore = () =>
    [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Load more'),
    )!;
  const fresh = (id: string, minute: number) =>
    usage(id, `2026-01-05T10:0${minute}:00.000Z`, {
      agent: 'claude',
      session_id: 's1',
      command: 'section',
      section_id: 'cli#CLI#New',
    });
  const facetBox = (field: string, value: string) =>
    container.querySelector<HTMLInputElement>(
      `input[type="checkbox"][data-facet="${field}"][data-value="${value}"]`,
    )!;
  const facetCount = (field: string, value: string) =>
    facetBox(field, value).closest('label')!.textContent!;

  async function show(searchString = '') {
    window.history.replaceState(null, '', `/_usage/explore${searchString}`);
    await act(async () => root.render(createElement(ExplorePage, {})));
    await act(async () => {});
    await act(async () => {});
  }

  beforeEach(() => {
    events = all;
    pageSize = 200;
    overlap = false;
    failRaw = undefined;
    hangEvents = false;
    holdCursor = undefined;
    requests = [];
    streams.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        const [path, query = ''] = url.split('?');
        const params = new URLSearchParams(query);
        if (failRaw)
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: failRaw }),
          };
        if (
          hangEvents &&
          !query.includes('facet=') &&
          !query.includes('limit=')
        )
          return new Promise<never>(() => {});
        let pool = events;
        const ids = params.get('ids');
        if (ids) pool = pool.filter((r) => ids.split(',').includes(r.id));
        for (const name of new Set(params.keys())) {
          if (!name.startsWith('where.')) continue;
          const field = name.slice('where.'.length) as FacetField;
          const wanted = params.getAll(name);
          pool = pool.filter((r) => {
            const v = valueOf(r, field);
            return v != null && wanted.includes(String(v));
          });
        }
        const facet = params.get('facet') as FacetField | null;
        if (path === '/api/usage/raw' && facet)
          return {
            ok: true,
            status: 200,
            json: async () => facetOf(pool, facet),
          };
        if (holdCursor && params.get('cursor')) await holdCursor;
        const start = params.get('cursor') ? Number(params.get('cursor')) : 0;
        const slice = pool.slice(start, start + pageSize);
        const records =
          overlap && start > 0 ? [pool[start - 1], ...slice] : slice;
        const body: RawEventsPage = {
          records,
          total: pool.length,
          next_cursor:
            start + pageSize < pool.length ? String(start + pageSize) : null,
        };
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

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Selecting facet values filters the table and updates counts]]
  it('filters the table by facet values and recounts', async () => {
    await show();
    expect(rowIds()).toEqual(['u1', 'u2', 'u3', 'u4', 'k1']);
    expect(facetCount('command', 'section')).toContain('2');
    expect(text()).toContain('top 20');
    await click(facetBox('command', 'section'));
    expect(rowIds()).toEqual(['u2', 'u3']);
    // the agent facet recounts over the two remaining events
    expect(facetCount('agent', 'claude')).toContain('1');
    expect(facetCount('agent', 'codex')).toContain('1');
    // own-field counts keep showing the other values of that field
    expect(facetCount('command', 'search')).toContain('1');
    await click(facetBox('agent', 'codex'));
    expect(rowIds()).toEqual(['u3']);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Facets and group-by are filtered by the server]]
  it('sends ticked values to the server and never loads every event', async () => {
    pageSize = 2;
    await show();
    await click(facetBox('command', 'section'));
    await click(facetBox('command', 'check'));
    await click(facetBox('agent', 'codex'));
    const table = requests.filter(
      (r) =>
        r.startsWith('/api/usage/raw') &&
        !r.includes('facet=') &&
        r.includes('where.agent'),
    );
    expect(table.at(-1)).toContain('where.command=section');
    expect(table.at(-1)).toContain('where.command=check');
    expect(table.at(-1)).toContain('where.agent=codex');
    // a facet leaves its own field out of the filter
    const agentFacet = requests.filter((r) => r.includes('facet=agent'));
    expect(agentFacet.at(-1)).toContain('where.command=section');
    expect(agentFacet.at(-1)).not.toContain('where.agent');
    expect(rowIds()).toEqual(['u3']);
    await click(facetBox('agent', 'codex'));
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Group by"]',
    )!;
    await act(async () => {
      select.value = 'session_id';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(requests.at(-1)).toContain('facet=session_id');
    expect(requests.at(-1)).toContain('where.command=section');
    // every request is one page or one facet: none asks for a second page
    expect(requests.some((r) => r.includes('cursor='))).toBe(false);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#The event count comes from the server total]]
  it('shows the server total, not the loaded rows', async () => {
    pageSize = 2;
    await show();
    expect(rowIds()).toEqual(['u1', 'u2']);
    expect(text()).toContain('5 events');
    await click(facetBox('command', 'section'));
    expect(text()).toContain('2 events');
    expect(text()).not.toContain('5 events');
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#The filtered view refreshes on usage changes]]
  it('refreshes the filtered view when the server reports a change', async () => {
    await show();
    await click(facetBox('command', 'section'));
    expect(rowIds()).toEqual(['u2', 'u3']);
    const fresh = usage('u5', '2026-01-05T10:05:00.000Z', {
      agent: 'claude',
      session_id: 's1',
      command: 'section',
      section_id: 'cli#CLI#New',
    });
    events = [fresh, ...all];
    await act(async () => {
      streams.at(-1)!.listeners['usage-change']();
    });
    await act(async () => {});
    await act(async () => {});
    expect(rowIds()).toEqual(['u5', 'u2', 'u3']);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Stale rows are never shown under new filters]]
  it('hides the old rows as soon as the event selection changes', async () => {
    await show('?event=u1&event=u2');
    expect(rowIds()).toEqual(['u1', 'u2']);
    hangEvents = true;
    await act(async () => {
      window.history.replaceState(null, '', '/_usage/explore?event=k1');
      window.dispatchEvent(new Event('usage-location-change'));
    });
    expect(rowIds()).toEqual([]);
    expect(text()).toContain('Loading events');
    expect(text()).not.toContain('2 events');
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Ticking a facet keeps the sidebar mounted]]
  it('keeps the ticked checkbox mounted while the events load', async () => {
    await show();
    const box = facetBox('command', 'section');
    hangEvents = true;
    await click(box);
    expect(box.isConnected).toBe(true);
    expect(box.checked).toBe(true);
    expect(
      container.querySelector('[aria-label="Facets"] fieldset'),
    ).not.toBeNull();
    hangEvents = false;
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Group-by produces counts by the chosen field]]
  it('groups events into counts by the chosen field', async () => {
    await show();
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Group by"]',
    )!;
    await act(async () => {
      select.value = 'agent';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const rows = [
      ...container.querySelectorAll('[data-group-table] tbody tr'),
    ].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(rows).toEqual([
      ['claude', '3'],
      ['codex', '1'],
      ['unknown', '1'],
    ]);
    expect(container.querySelector('[data-event-table]')).toBeNull();
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Paging loads the next page without duplicates]]
  it('loads the next page without duplicates', async () => {
    pageSize = 2;
    overlap = true;
    await show();
    expect(rowIds()).toEqual(['u1', 'u2']);
    const more = [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Load more'),
    )!;
    await click(more);
    await act(async () => {});
    expect(rowIds()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(requests.some((r) => r.includes('cursor='))).toBe(true);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Load more stays mounted while the next page loads]]
  it('keeps the focused Load more button, disabled, while the next page loads', async () => {
    pageSize = 2;
    await show();
    let release!: () => void;
    holdCursor = new Promise<void>((resolve) => (release = resolve));
    const button = loadMore();
    button.focus();
    await click(button);
    expect(loadMore()).toBe(button);
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(button);
    release();
    await act(async () => {});
    expect(rowIds()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(button.disabled).toBe(false);
    await click(loadMore());
    await act(async () => {});
    expect(rowIds()).toEqual(['u1', 'u2', 'u3', 'u4', 'k1']);
    expect(loadMore()).toBeUndefined();
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Load more stays mounted while the next page loads]]
  it('keeps Load more away while a live change refetches the last page', async () => {
    pageSize = 4;
    await show();
    await click(loadMore());
    await act(async () => {});
    expect(rowIds()).toEqual(['u1', 'u2', 'u3', 'u4', 'k1']);
    expect(loadMore()).toBeUndefined();
    let release!: () => void;
    holdCursor = new Promise<void>((resolve) => (release = resolve));
    await act(async () => {
      streams.at(-1)!.listeners['usage-change']();
    });
    await act(async () => {});
    expect(loadMore()).toBeUndefined();
    release();
    await act(async () => {});
    expect(loadMore()).toBeUndefined();
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#A live change after load more shows new events and keeps older pages]]
  it('shows a new event at the top after load more, keeping older pages', async () => {
    pageSize = 2;
    await show();
    const more = [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Load more'),
    )!;
    await click(more);
    await act(async () => {});
    expect(rowIds()).toEqual(['u1', 'u2', 'u3', 'u4']);
    events = [
      usage('u5', '2026-01-05T10:05:00.000Z', {
        agent: 'claude',
        session_id: 's1',
        command: 'section',
        section_id: 'cli#CLI#New',
      }),
      ...all,
    ];
    await act(async () => {
      streams.at(-1)!.listeners['usage-change']();
    });
    await act(async () => {});
    await act(async () => {});
    expect(rowIds()).toEqual(['u5', 'u1', 'u2', 'u3', 'u4']);
    expect(text()).toContain('6 events');
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#A live change after load more shows new events and keeps older pages]]
  it('drops a row that stops matching in the refreshed first page', async () => {
    pageSize = 2;
    await show();
    const more = [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Load more'),
    )!;
    await click(more);
    await act(async () => {});
    events = all.filter((r) => r.id !== 'u1');
    await act(async () => {
      streams.at(-1)!.listeners['usage-change']();
    });
    await act(async () => {});
    await act(async () => {});
    expect(rowIds()).toEqual(['u2', 'u3', 'u4', 'k1']);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#A live change after load more shows new events and keeps older pages]]
  it('continues to older rows with Load more after a live change', async () => {
    pageSize = 2;
    await show();
    await click(loadMore());
    await act(async () => {});
    events = [fresh('u5', 5), ...all];
    await act(async () => {
      streams.at(-1)!.listeners['usage-change']();
    });
    await act(async () => {});
    await act(async () => {});
    await click(loadMore());
    await act(async () => {});
    expect(rowIds()).toEqual(['u5', 'u1', 'u2', 'u3', 'u4', 'k1']);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#A live change after load more shows new events and keeps older pages]]
  it('starts over from the first page when new events outnumber a page', async () => {
    pageSize = 2;
    await show();
    await click(loadMore());
    await act(async () => {});
    events = [fresh('u7', 7), fresh('u6', 6), fresh('u5', 5), ...all];
    await act(async () => {
      streams.at(-1)!.listeners['usage-change']();
    });
    await act(async () => {});
    await act(async () => {});
    expect(rowIds()).toEqual(['u7', 'u6']);
    await click(loadMore());
    await act(async () => {});
    expect(rowIds()).toEqual(['u7', 'u6', 'u5', 'u1']);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Export downloads the current filtered result as JSON lines]]
  it('exports the filtered result as JSON lines', async () => {
    pageSize = 2;
    await show();
    await click(facetBox('command', 'section'));
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Export'),
    )!;
    await click(button);
    await act(async () => {});
    await act(async () => {});
    expect(clicked).toHaveBeenCalled();
    const body = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob!);
    });
    const lines = body.trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([u2, u3]);
    clicked.mockRestore();
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Selected events show exactly those events]]
  it('shows exactly the events named by the event parameter', async () => {
    await show('?agent=claude&event=u2&event=k1');
    const raw = requests.filter((r) => r.startsWith('/api/usage/raw'));
    expect(raw.some((r) => r.includes('ids=u2%2Ck1'))).toBe(true);
    expect(rowIds()).toEqual(['u2', 'k1']);
    expect(text()).toContain('Showing 2 selected events');
    const clear = [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Clear selection'),
    )!;
    await click(clear);
    await act(async () => {});
    expect(window.location.search).toBe('?agent=claude');
    expect(text()).not.toContain('selected events');
    expect(rowIds().length).toBe(5);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Unknown values are shown as unknown and no command text is shown]]
  it('shows null as unknown and never renders command text', async () => {
    await show();
    const u4row = container.querySelector('[data-event-id="u4"]')!;
    expect(u4row.textContent).toContain('unknown');
    expect(text()).not.toContain('SECRET-COMMAND');
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Unknown values are shown as unknown and no command text is shown]]
  it('shows a null with no reason as a dash, and unknown only with a reason', async () => {
    const u5 = usage('u5', '2026-01-05T09:59:00.000Z', {
      agent: 'claude',
      session_id: 's1',
      unknown_reasons: { error_class: 'not_captured' },
    });
    events = [...all, u5];
    await show();
    const errorClass = (id: string) =>
      container.querySelectorAll(`[data-event-id="${id}"] td`)[7].textContent;
    expect(errorClass('u1')).toBe('—');
    expect(errorClass('u5')).toBe('unknown');
    const facet = [...container.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')!.textContent === 'error_class',
    )!;
    expect(facet.textContent).toContain('none (');
    expect(facet.textContent).toContain('unknown (1)');
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Unknown values are shown as unknown and no command text is shown]]
  it('shows a section only as unknown when a reason is recorded', async () => {
    const u6 = usage('u6', '2026-01-05T09:58:00.000Z', {
      agent: 'claude',
      session_id: 's1',
      command: 'section',
      unknown_reasons: { section_id: 'not_captured' },
    });
    events = [...all, u6];
    await show();
    const section = (id: string) =>
      container.querySelectorAll(`[data-event-id="${id}"] td`)[5].textContent;
    expect(section('u1')).toBe('—');
    expect(section('u6')).toBe('unknown');
    const facet = [...container.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')!.textContent === 'section_id',
    )!;
    expect(facet.textContent).toContain('none (');
    expect(facet.textContent).toContain('unknown (1)');
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Group by"]',
    )!;
    await act(async () => {
      select.value = 'section_id';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});
    const rows = [
      ...container.querySelectorAll('[data-group-table] tbody tr'),
    ].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(rows).toContainEqual(['none', '2']);
    expect(rows).toContainEqual(['unknown', '1']);
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#A bypass read shows its path]]
  it('shows the path of a bypass read', async () => {
    const b1 = {
      ...k1,
      id: 'b1',
      event: {
        ...k1.event,
        event_id: 'b1',
        kind: 'bypass_read',
        path: 'lat.md/cli.md',
        bytes: 120,
      },
    } as unknown as RawRecord;
    events = [...all, b1];
    await show();
    const cells = container.querySelectorAll('[data-event-id="b1"] td');
    expect(cells[5].textContent).toBe('lat.md/cli.md');
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#Links keep the filter query string]]
  it('keeps the filters in session and section links', async () => {
    await show('?agent=claude&event=u2');
    const hrefs = [...container.querySelectorAll('a')].map(
      (a) => a.getAttribute('href')!,
    );
    expect(hrefs).toContain('/_usage/sessions/s1?agent=claude');
    expect(hrefs).toContain(
      '/_usage/knowledge/cli%23CLI%23Search?agent=claude',
    );
  });

  // @lat: [[usage-dashboard-explore#Usage Dashboard Explore#States show loading, errors and empty results]]
  it('shows the error message and the empty state', async () => {
    failRaw = 'Invalid limit: abc';
    await show();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'Invalid limit: abc',
    );
    failRaw = undefined;
    events = [];
    await show('?agent=nobody');
    expect(text()).toContain('No events match');
  });
});
