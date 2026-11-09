import { useEffect, useRef, useState } from 'react';
import type {
  RawEventsPage,
  RawRecord,
} from '../../../src/fork/usage/event-index';
import { filtersToSearchParams, useUsageFilters } from './filters';

export type UsageData<T> = {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
};

type StreamMessage = { type: 'refresh' } | { type: 'error'; message: string };

const streamListeners = new Set<(message: StreamMessage) => void>();
let stream: EventSource | null = null;
let suspended = false;
let connectedBefore = false;

function notify(message: StreamMessage): void {
  for (const listener of streamListeners) listener(message);
}

function disconnect(): void {
  stream?.close();
  stream = null;
}

/** Opens the stream when visible and closed, closes it when hidden. A reopen asks for a refresh, as events may have been missed. */
function synchronize(): void {
  if (suspended || document.visibilityState === 'hidden') {
    disconnect();
    return;
  }
  if (stream) return;
  const reopened = connectedBefore;
  stream = new EventSource('/api/usage/events');
  connectedBefore = true;
  stream.addEventListener('usage-change', () => notify({ type: 'refresh' }));
  stream.addEventListener('usage-error', (event) => {
    const { message } = JSON.parse((event as MessageEvent<string>).data);
    notify({ type: 'error', message: String(message) });
  });
  if (reopened) notify({ type: 'refresh' });
}
function hide(): void {
  suspended = true;
  disconnect();
}

function show(): void {
  suspended = false;
  synchronize();
}

/** One event stream serves every hook on the page; it closes with the last subscriber. */
function subscribeToStream(
  listener: (message: StreamMessage) => void,
): () => void {
  streamListeners.add(listener);
  if (streamListeners.size === 1) {
    connectedBefore = false;
    suspended = false;
    document.addEventListener('visibilitychange', synchronize);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    synchronize();
  }
  return () => {
    streamListeners.delete(listener);
    if (streamListeners.size > 0) return;
    document.removeEventListener('visibilitychange', synchronize);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    disconnect();
  };
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Fetches a usage endpoint under the shared filters and refetches when the server reports a change. */
export function useUsageData<T>(
  path: string,
  extraParams?: Record<string, string>,
): UsageData<T> {
  const { filters } = useUsageFilters();
  const params = filtersToSearchParams(filters);
  for (const [name, value] of Object.entries(extraParams ?? {}))
    params.set(name, value);
  const url = withQuery(path, params);
  const [state, setState] = useState<UsageData<T>>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [refreshes, setRefreshes] = useState(0);
  const inFlight = useRef(false);
  const stale = useRef(false);

  // @lat: [[usage-dashboard-data-hook#Usage Dashboard Data Hook#A change during a request lets it finish]]
  useEffect(
    () =>
      subscribeToStream((message) => {
        if (message.type !== 'refresh')
          setState((current) => ({
            ...current,
            error: new Error(message.message),
          }));
        else if (inFlight.current) stale.current = true;
        else setRefreshes((count) => count + 1);
      }),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = true;
    stale.current = false;
    const settle = () => {
      inFlight.current = false;
      if (!stale.current) return;
      stale.current = false;
      setRefreshes((count) => count + 1);
    };
    setState((current) => ({ ...current, loading: true }));
    fetchJson<T>(url, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: undefined, loading: false });
        settle();
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }));
        settle();
      },
    );
    return () => {
      controller.abort();
      inFlight.current = false;
    };
  }, [url, refreshes]);

  return state;
}

/** Every raw event under the given parameters, following the cursor to the last page. */
export async function fetchAllUsageEvents(
  params: Record<string, string> = {},
): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams(params);
    if (cursor) query.set('cursor', cursor);
    const page: RawEventsPage = await fetchJson(
      withQuery('/api/usage/raw', query),
    );
    for (const record of page.records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
    cursor = page.next_cursor;
  } while (cursor);
  return records;
}
