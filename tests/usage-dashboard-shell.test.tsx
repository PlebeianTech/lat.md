// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageApp } from '../view/src/usage/usage-app';
import { useUsageFilters } from '../view/src/usage/filters';
import { useUsageData } from '../view/src/usage/use-usage-data';
import { forkViewInputs } from '../view/src/usage/vite-inputs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PAGES = [
  ['Overview', '/_usage'],
  ['Findings', '/_usage/findings'],
  ['Sessions', '/_usage/sessions'],
  ['Issues', '/_usage/issues'],
  ['Knowledge', '/_usage/knowledge'],
  ['Queries', '/_usage/queries'],
  ['Agents', '/_usage/agents'],
  ['Utilization', '/_usage/utilization'],
  ['Explore', '/_usage/explore'],
] as const;

describe('usage dashboard shell', () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render(element: ReactElement): Promise<void> {
    await act(async () => root.render(element));
  }
  async function open(url: string): Promise<void> {
    window.history.replaceState(null, '', url);
    await render(createElement(UsageApp));
  }
  const main = () => container.querySelector('main')!;
  const navLink = (name: string) =>
    [...container.querySelectorAll('nav a')].find(
      (link) => link.textContent === name,
    ) as HTMLAnchorElement;
  const field = (name: string) =>
    container.querySelector(`[name="${name}"]`) as
      | HTMLInputElement
      | HTMLSelectElement;
  async function edit(name: string, value: string): Promise<void> {
    const element = field(name);
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // The endpoint the Sessions page fetches its rows from; one place to change.
  const SUMMARY_PATH = '/api/usage/sessions';
  const fetchMock = vi.fn((_url: string) => new Promise(() => {}));
  const summaryRequests = () =>
    fetchMock.mock.calls
      .map(([url]) => url)
      .filter((url) => url.split('?')[0] === SUMMARY_PATH);
  async function typeInto(name: string, value: string): Promise<void> {
    const element = field(name);
    await act(async () => element.focus());
    for (let length = 1; length <= value.length; length++)
      await edit(name, value.slice(0, length));
  }
  async function leave(name: string): Promise<void> {
    await act(async () => field(name).blur());
  }
  async function pressEnter(name: string): Promise<void> {
    await act(async () =>
      field(name).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
  }

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        close() {}
      },
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

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Every navigation entry routes to its page]]
  it('routes every navigation entry to its page', async () => {
    await open('/_usage');
    for (const [name, path] of PAGES) {
      await act(async () => navLink(name).click());
      expect(window.location.pathname).toBe(path);
      expect(navLink(name).getAttribute('aria-current')).toBe('page');
      expect(main().textContent).not.toContain('Page not found');
    }
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Detail paths route with their id]]
  it('routes detail paths with their id', async () => {
    await open('/_usage/sessions/abc');
    expect(main().textContent).toContain('Sessions');
    expect(main().textContent).toContain('abc');
    const id = 'cli#CLI#search/Backend selection';
    await open(`/_usage/knowledge/${encodeURIComponent(id)}`);
    expect(main().textContent).toContain('Knowledge');
    expect(main().textContent).toContain(id);
    await open('/_usage/nowhere');
    expect(main().textContent).toContain('Page not found');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Changing a filter updates the URL and the filter state]]
  it('writes a changed filter to the URL and exposes it to pages', async () => {
    function Probe(): ReactElement {
      const { filters } = useUsageFilters();
      return createElement('output', null, JSON.stringify(filters));
    }
    await open('/_usage/sessions');
    await render(
      createElement('div', null, createElement(UsageApp), createElement(Probe)),
    );
    await edit('agent', 'codex');
    await typeInto('issue', 'lat-eah');
    await leave('issue');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('agent')).toBe('codex');
    expect(params.get('issue')).toBe('lat-eah');
    expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual(
      { agent: 'codex', issue: 'lat-eah' },
    );
    await edit('agent', '');
    expect(new URLSearchParams(window.location.search).has('agent')).toBe(
      false,
    );
    expect(window.location.pathname).toBe('/_usage/sessions');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Text filters apply on Enter or blur]]
  it.each(['issue', 'session'])(
    'applies the %s filter on blur, not per keystroke',
    async (name) => {
      await open('/_usage/sessions');
      const before = summaryRequests().length;
      const url = window.location.href;
      await typeInto(name, 'lat-eah.19');
      expect(field(name).value).toBe('lat-eah.19');
      expect(summaryRequests().length).toBe(before);
      expect(window.location.href).toBe(url);
      await leave(name);
      expect(summaryRequests().length).toBe(before + 1);
      expect(summaryRequests().at(-1)).toBe(
        `${SUMMARY_PATH}?${name}=lat-eah.19`,
      );
    },
  );

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Text filters apply on Enter or blur]]
  it.each(['issue', 'session'])(
    'applies the %s filter on Enter',
    async (name) => {
      await open('/_usage/sessions');
      const before = summaryRequests().length;
      await typeInto(name, 'abc');
      expect(summaryRequests().length).toBe(before);
      await pressEnter(name);
      expect(summaryRequests().length).toBe(before + 1);
      expect(summaryRequests().at(-1)).toBe(`${SUMMARY_PATH}?${name}=abc`);
      await leave(name);
      expect(summaryRequests().length).toBe(before + 1);
    },
  );

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Text filters follow the URL]]
  it('shows a filter value that changes in the URL', async () => {
    await open('/_usage/sessions?issue=lat-1');
    expect(field('issue').value).toBe('lat-1');
    await act(async () => {
      window.history.replaceState(null, '', '/_usage/sessions?issue=lat-2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(field('issue').value).toBe('lat-2');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Date and agent controls apply at once]]
  it('refetches at once when from, to or agent change', async () => {
    await open('/_usage/sessions');
    for (const [name, value] of [
      ['from', '2026-01-01'],
      ['to', '2026-02-01'],
      ['agent', 'codex'],
    ]) {
      const before = summaryRequests().length;
      await edit(name, value);
      expect(summaryRequests().length).toBe(before + 1);
    }
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Loading a URL with filters restores them]]
  it('restores filters from the URL', async () => {
    function Probe(): ReactElement {
      const { filters } = useUsageFilters();
      return createElement('output', null, JSON.stringify(filters));
    }
    window.history.replaceState(
      null,
      '',
      '/_usage/findings?from=2026-01-01&to=2026-02-01&agent=pi&session=s1&issue=lat-1',
    );
    await render(
      createElement('div', null, createElement(UsageApp), createElement(Probe)),
    );
    expect(field('from').value).toBe('2026-01-01');
    expect(field('to').value).toBe('2026-02-01');
    expect(field('agent').value).toBe('pi');
    expect(field('session').value).toBe('s1');
    expect(field('issue').value).toBe('lat-1');
    expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual(
      {
        from: '2026-01-01',
        to: '2026-02-01',
        agent: 'pi',
        session: 's1',
        issue: 'lat-1',
      },
    );
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Navigation keeps the filters]]
  it('keeps the filters when navigating', async () => {
    await open('/_usage?agent=codex&issue=lat-1');
    await act(async () => navLink('Agents').click());
    expect(window.location.pathname).toBe('/_usage/agents');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('agent')).toBe('codex');
    expect(params.get('issue')).toBe('lat-1');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Navigation keeps the filters]]
  it('carries only the filters, not a page parameter such as event', async () => {
    await open('/_usage/explore?event=evt-1&agent=claude');
    expect(navLink('Sessions').getAttribute('href')).toBe(
      '/_usage/sessions?agent=claude',
    );
    expect(navLink('Explore').getAttribute('href')).toBe(
      '/_usage/explore?agent=claude',
    );
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#A malformed detail path shows not found]]
  it('shows not found for a malformed escape in a detail path', async () => {
    await open('/_usage/sessions/%E0%A4%A');
    expect(main().textContent).toContain('Page not found');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Consecutive filter changes both apply]]
  it('applies two setFilters calls made in the same tick', async () => {
    let apply: () => void = () => {};
    function Probe(): ReactElement {
      const { setFilters } = useUsageFilters();
      apply = () => {
        setFilters({ agent: 'pi' });
        setFilters({ issue: 'lat-9' });
      };
      return createElement('span');
    }
    await open('/_usage/sessions');
    await render(
      createElement('div', null, createElement(UsageApp), createElement(Probe)),
    );
    await act(async () => apply());
    const params = new URLSearchParams(window.location.search);
    expect(params.get('agent')).toBe('pi');
    expect(params.get('issue')).toBe('lat-9');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Changing a filter keeps page parameters]]
  it('keeps page parameters when a filter changes', async () => {
    let apply: () => void = () => {};
    function Probe(): ReactElement {
      const { setFilters } = useUsageFilters();
      apply = () => setFilters({ agent: 'codex' });
      return createElement('span');
    }
    window.history.replaceState(
      null,
      '',
      '/_usage/explore?agent=claude&event=e1&event=e2',
    );
    await render(createElement(Probe));
    await act(async () => apply());
    const params = new URLSearchParams(window.location.search);
    expect(params.get('agent')).toBe('codex');
    expect(params.getAll('event')).toEqual(['e1', 'e2']);
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#An unlisted agent stays visible]]
  it('shows an agent that is not in the known list', async () => {
    await open('/_usage?agent=mystery');
    expect(field('agent').value).toBe('mystery');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#Filters serialize to search parameters]]
  it('serializes only the filters that are set', async () => {
    const { filtersToSearchParams } = await import('../view/src/usage/filters');
    expect(
      filtersToSearchParams({
        agent: 'pi',
        issue: 'x',
        session: '',
      }).toString(),
    ).toBe('agent=pi&issue=x');
    expect(filtersToSearchParams({}).toString()).toBe('');
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#A page using the data hook starts out loading]]
  it('reports loading on first render before the fetch resolves', async () => {
    function Probe(): ReactElement {
      const result = useUsageData<string>('/api/usage');
      return createElement('output', null, JSON.stringify(result));
    }
    await render(createElement(Probe));
    expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual(
      { loading: true },
    );
  });

  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#The Vite build declares both entries]]
  it('declares both Vite entries', () => {
    expect(forkViewInputs('/v')).toEqual({
      index: '/v/index.html',
      usage: '/v/usage.html',
    });
  });
});
