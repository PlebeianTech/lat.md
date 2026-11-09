const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Query parameters of GET /api/usage and the flags of `lat usage`. */
export interface UsageFilters {
  /** ISO date or date-time; the range starts here. */
  from?: string;
  /** ISO date or date-time; a date-only value includes that whole day. */
  to?: string;
  agent?: string;
  /** A session id or a session name. */
  session?: string;
  /** A bd issue id; its descendants are included. */
  issue?: string;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function parameter(params: Params, name: string): string | undefined {
  const raw =
    params instanceof URLSearchParams
      ? (params.get(name) ?? undefined)
      : params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === '' ? undefined : value;
}

function validDate(name: string, value: string | undefined) {
  if (value !== undefined && Number.isNaN(Date.parse(value)))
    throw new Error(`Invalid ${name} date: ${value}`);
}

export function parseUsageFilters(params: Params): UsageFilters {
  const filters: UsageFilters = {};
  for (const name of ['from', 'to', 'agent', 'session', 'issue'] as const) {
    const value = parameter(params, name);
    if (value === undefined) continue;
    if (name === 'from' || name === 'to') validDate(name, value);
    filters[name] = value;
  }
  return filters;
}

export function filtersKey(filters: UsageFilters): string {
  return JSON.stringify(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Half-open time span [from, to) in epoch milliseconds. */
export interface TimeSpan {
  from: number;
  to: number;
}

export interface UsageRange {
  /** Null when the filter leaves that side open. */
  from: number | null;
  /** Exclusive end. */
  to: number | null;
  /** The span of equal length before `from`; null without a `from`. */
  previous: TimeSpan | null;
}

/**
 * A date-only `to` ends after that day; a date-time `to` is the exclusive
 * end. With a `from` and no `to` the previous range is as long as `from`
 * to `now`.
 */
export function resolveRange(filters: UsageFilters, now: number): UsageRange {
  const from = filters.from === undefined ? null : Date.parse(filters.from);
  const to =
    filters.to === undefined
      ? null
      : Date.parse(filters.to) + (DATE_ONLY.test(filters.to) ? DAY_MS : 0);
  if (from === null) return { from, to, previous: null };
  const length = Math.max((to ?? now) - from, 0);
  return {
    from,
    to,
    previous: length > 0 ? { from: from - length, to: from } : null,
  };
}
