import { useCallback, useSyncExternalStore } from 'react';

export type UsageFilters = {
  from?: string;
  to?: string;
  agent?: string;
  session?: string;
  issue?: string;
};

const FILTER_NAMES = ['from', 'to', 'agent', 'session', 'issue'] as const;
const LOCATION_CHANGE = 'usage-location-change';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(LOCATION_CHANGE, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(LOCATION_CHANGE, onChange);
  };
}

/** The current pathname and query string, re-read whenever the dashboard navigates. */
export function useUsageLocation(): { pathname: string; search: string } {
  const pathname = useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
  );
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return { pathname, search };
}

/** Moves to a path and query string without a page load. */
export function navigateTo(url: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(LOCATION_CHANGE));
}

function readFilters(search: string): UsageFilters {
  const params = new URLSearchParams(search);
  const filters: UsageFilters = {};
  for (const name of FILTER_NAMES) {
    const value = params.get(name);
    if (value) filters[name] = value;
  }
  return filters;
}

/** The set filters as search parameters, named as the usage endpoints read them. */
export function filtersToSearchParams(filters: UsageFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = filters[name];
    if (value) params.set(name, value);
  }
  return params;
}

/** The filters in the URL, and a setter that merges changes into it. An empty value clears a filter. */
export function useUsageFilters(): {
  filters: UsageFilters;
  setFilters: (changes: UsageFilters) => void;
} {
  const { search } = useUsageLocation();
  const setFilters = useCallback((changes: UsageFilters) => {
    // Change only the filter names; page parameters such as Explore's
    // `event=` selection stay.
    const next = new URLSearchParams(window.location.search);
    for (const name of FILTER_NAMES) {
      if (!(name in changes)) continue;
      const value = changes[name];
      if (value) next.set(name, value);
      else next.delete(name);
    }
    const query = next.toString();
    navigateTo(
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
      true,
    );
  }, []);
  return { filters: readFilters(search), setFilters };
}
