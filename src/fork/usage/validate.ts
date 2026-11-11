import { TOKEN_COUNTERS } from './aggregate-types.js';
import { USAGE_SCHEMA_VERSION, type UsageEvent } from './schema.js';

type FieldType = 'string' | 'number' | 'boolean';

/** The type each UsageEvent field must have; `?` allows null. */
const FIELD_TYPES: Record<string, `${FieldType}${'' | '?'}`> = {
  event_id: 'string',
  ts: 'string',
  duration_ms: 'number',
  command: 'string',
  surface: 'string',
  caller: 'string',
  agent: 'string?',
  lat_version: 'string',
  session_id: 'string?',
  parent_session_id: 'string?',
  repo_root: 'string',
  git_head: 'string?',
  worktree: 'string?',
  query: 'string?',
  result_count: 'number?',
  section_id: 'string?',
  injected_bytes: 'number?',
  found: 'boolean?',
  bytes_out: 'number?',
  exit_code: 'number',
  error_class: 'string?',
};

const EARLIEST_TS = Date.parse('2000-01-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A ts must parse and fall between 2000-01-01 and one day from now. One event
 * in year 3000 would otherwise make the day range span a million days.
 */
export function plausibleTs(ts: unknown): boolean {
  if (typeof ts !== 'string') return false;
  const ms = Date.parse(ts);
  return ms >= EARLIEST_TS && ms <= Date.now() + DAY_MS;
}

function hasType(value: unknown, type: string): boolean {
  if (value === null) return type.endsWith('?');
  return typeof value === type.replace('?', '');
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent and null both mean unknown. */
function validCount(value: unknown): boolean {
  return value === null || value === undefined || Number.isFinite(value);
}

function validTokenUsage(usage: unknown): boolean {
  return (
    isPlainObject(usage) &&
    [...TOKEN_COUNTERS, 'reported_cost_usd'].every((field) =>
      validCount(usage[field]),
    )
  );
}

function validToolCall(tool: unknown, source: unknown): boolean {
  return (
    isPlainObject(tool) &&
    hasType(tool.path, 'string?') &&
    isPlainObject(source) &&
    typeof source.path === 'string'
  );
}

function validKindFields(event: Record<string, unknown>): boolean {
  switch (event.kind) {
    case 'session_start':
    case 'session_end':
      return true;
    case 'session_name':
      return typeof event.name === 'string';
    case 'model':
      return typeof event.model === 'string';
    case 'tool_call':
      return validToolCall(event.tool, event.source);
    case 'token_usage':
      return validTokenUsage(event.usage);
    case 'bypass_read':
      return typeof event.path === 'string';
    case 'bd_command':
      return (
        typeof event.issue_id === 'string' &&
        (event.verb === 'claim' || event.verb === 'close')
      );
    default:
      return false;
  }
}

// @lat: [[usage-analytics#Usage Analytics#Usage event#Usage event fields]]
export function validSessionEvent(event: unknown): boolean {
  return (
    isPlainObject(event) &&
    typeof event.event_id === 'string' &&
    typeof event.session_id === 'string' &&
    (event.parent_session_id === undefined ||
      typeof event.parent_session_id === 'string') &&
    plausibleTs(event.ts) &&
    validKindFields(event)
  );
}

/**
 * A usage event is trusted only when it has the current schema version, every
 * field has its declared type and its ts is plausible.
 */
export function validUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    event.schema_version === USAGE_SCHEMA_VERSION &&
    Object.entries(FIELD_TYPES).every(([field, type]) =>
      hasType(event[field], type),
    ) &&
    plausibleTs(event.ts) &&
    Array.isArray(event.result_ids) &&
    event.result_ids.every((id) => typeof id === 'string') &&
    typeof event.unknown_reasons === 'object' &&
    event.unknown_reasons !== null
  );
}
