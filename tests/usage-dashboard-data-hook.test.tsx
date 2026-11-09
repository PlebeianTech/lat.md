// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllUsageEvents,
  useUsageData,
} from '../view/src/usage/use-usage-data';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(
    name: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown = {}) {
    const event = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}
const openStreams = () => FakeEventSource.instances.filter((s) => !s.closed);

type Request = {
  url: string;
  signal: AbortSignal | undefined;
  respond: (body: unknown, status?: number) => void;
};

describe('usage dashboard data hook', () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: Request[];
  let visibility: 'visible' | 'hidden';

  async function render(element: ReactElement): Promise<void> {
    await act(async () => root.render(element));
  }
  const settle = () => act(async () => {});
  async function respond(
    request: Request,
    body: unknown,
    status = 200,
  ): Promise<void> {
    await act(async () => request.respond(body, status));
  }
  async function setVisibility(state: 'visible' | 'hidden'): Promise<void> {
    visibility = state;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  async function emit(name: string, data?: unknown): Promise<void> {
    await act(async () => openStreams()[0].emit(name, data));
  }
  const last = () => requests[requests.length - 1];

  let seen: { data: unknown; error: Error | undefined; loading: boolean };
  function Probe(props: { path: string; extra?: Record<string, string> }) {
    seen = useUsageData(props.path, props.extra);
    return null;
  }
  const probe = (path = '/api/usage', extra?: Record<string, string>) =>
    createElement(Probe, { path, extra });

  beforeEach(() => {
    requests = [];
    visibility = 'visible';
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          requests.push({
            url,
            signal,
            respond: (body, status = 200) =>
              resolve(
                new Response(JSON.stringify(body), {
                  status,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
          });
        });
      }),
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    window.history.replaceState(null, '', '/_usage');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#The request carries the filters and extra parameters]]
  it('sends the filters and extra parameters', async () => {
    window.history.replaceState(null, '', '/_usage?agent=claude&issue=lat-1');
    await render(probe('/api/usage', { limit: '5' }));
    const url = new URL(last().url, 'http://x');
    expect(url.pathname).toBe('/api/usage');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agent: 'claude',
      issue: 'lat-1',
      limit: '5',
    });
    expect(seen.loading).toBe(true);
    await respond(last(), { ok: 1 });
    expect(seen).toEqual({ data: { ok: 1 }, error: undefined, loading: false });
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#A filter change refetches]]
  it('refetches when a filter changes', async () => {
    await render(probe());
    await respond(last(), { n: 1 });
    await act(async () => {
      window.history.replaceState(null, '', '/_usage?agent=codex');
      window.dispatchEvent(new Event('usage-location-change'));
    });
    expect(requests).toHaveLength(2);
    expect(new URL(last().url, 'http://x').searchParams.get('agent')).toBe(
      'codex',
    );
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#Previous data stays while refetching]]
  it('keeps the previous data while refetching', async () => {
    await render(probe());
    await respond(last(), { n: 1 });
    await emit('usage-change');
    expect(seen).toMatchObject({ data: { n: 1 }, loading: true });
    await respond(last(), { n: 2 });
    expect(seen).toMatchObject({ data: { n: 2 }, loading: false });
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#A stale response never overwrites newer data]]
  it('ignores a slow response for filters that changed', async () => {
    // A server that ignores abort still must not win.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((resolve) => {
          requests.push({
            url,
            signal: init?.signal,
            respond: (body) => resolve(new Response(JSON.stringify(body))),
          });
        });
      }),
    );
    await render(probe());
    await act(async () => {
      window.history.replaceState(null, '', '/_usage?agent=codex');
      window.dispatchEvent(new Event('usage-location-change'));
    });
    const [older, newer] = requests;
    await respond(newer, { n: 'new' });
    await respond(older, { n: 'old' });
    expect(seen.data).toEqual({ n: 'new' });
    expect(older.signal?.aborted).toBe(true);
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#A change during a request lets it finish]]
  it('finishes an in-flight request on a change, then refetches once', async () => {
    await render(probe());
    const inFlight = last();
    await emit('usage-change');
    await emit('usage-change');
    await emit('usage-change');
    expect(requests).toHaveLength(1);
    expect(inFlight.signal?.aborted).toBe(false);
    await respond(inFlight, { n: 1 });
    expect(seen.data).toEqual({ n: 1 });
    expect(requests).toHaveLength(2);
    expect(seen.loading).toBe(true);
    await respond(last(), { n: 2 });
    expect(seen).toEqual({ data: { n: 2 }, error: undefined, loading: false });
    expect(requests).toHaveLength(2);
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#A change event refetches once]]
  it('refetches once per change event for all components', async () => {
    const seenBy: unknown[] = [];
    function Second() {
      seenBy.push(useUsageData('/api/usage').data);
      return null;
    }
    await render(createElement('div', null, probe(), createElement(Second)));
    expect(requests).toHaveLength(2);
    await respond(requests[0], { n: 1 });
    await respond(requests[1], { n: 1 });
    await emit('usage-change', { instanceId: 'a' });
    expect(requests).toHaveLength(4);
    await respond(requests[2], { n: 2 });
    await respond(requests[3], { n: 2 });
    expect(seenBy[seenBy.length - 1]).toEqual({ n: 2 });
    expect(requests).toHaveLength(4);
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#A failed refresh keeps the last good data]]
  it('surfaces usage-error and server errors without discarding data', async () => {
    await render(probe());
    await respond(last(), { n: 1 });
    await emit('usage-error', { instanceId: 'a', message: 'refresh broke' });
    expect(seen.error?.message).toBe('refresh broke');
    expect(seen.data).toEqual({ n: 1 });
    expect(requests).toHaveLength(1);

    await emit('usage-change');
    await respond(last(), { n: 2 });
    expect(seen).toEqual({ data: { n: 2 }, error: undefined, loading: false });

    await emit('usage-change');
    await respond(last(), { error: 'Invalid date: nope' }, 500);
    expect(seen.error?.message).toBe('Invalid date: nope');
    expect(seen.data).toEqual({ n: 2 });
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#Components share one stream]]
  it('shares one stream and closes it with the last subscriber', async () => {
    function Two() {
      useUsageData('/api/usage/findings');
      return null;
    }
    await render(createElement('div', null, probe(), createElement(Two)));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/usage/events');
    await render(probe());
    expect(openStreams()).toHaveLength(1);
    await render(createElement('div'));
    expect(openStreams()).toHaveLength(0);
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#Hidden tabs close the stream]]
  it('closes the stream while hidden and reconnects once, refetching', async () => {
    await render(probe());
    await respond(last(), { n: 1 });
    await setVisibility('hidden');
    expect(openStreams()).toHaveLength(0);
    await setVisibility('visible');
    expect(openStreams()).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(requests).toHaveLength(2);
    await setVisibility('visible');
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#Unmounting aborts the request]]
  it('aborts an in-flight request on unmount', async () => {
    await render(probe());
    const inFlight = last();
    await render(createElement('div'));
    expect(inFlight.signal?.aborted).toBe(true);
    await settle();
  });

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#All raw events are fetched across pages]]
  it('follows the cursor across three pages without duplicates', async () => {
    const pages: Record<string, unknown> = {
      '': { records: [{ id: 'e3' }, { id: 'e2' }], next_cursor: 'c1' },
      c1: { records: [{ id: 'e2' }, { id: 'e1' }], next_cursor: 'c2' },
      c2: { records: [{ id: 'e0' }], next_cursor: null },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const params = new URL(url, 'http://x').searchParams;
        expect(new URL(url, 'http://x').pathname).toBe('/api/usage/raw');
        expect(params.get('agent')).toBe('claude');
        return new Response(JSON.stringify(pages[params.get('cursor') ?? '']));
      }),
    );
    const records = await fetchAllUsageEvents({ agent: 'claude' });
    expect(records.map((record) => record.id)).toEqual([
      'e3',
      'e2',
      'e1',
      'e0',
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
