import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

export const USAGE_SCHEMA_VERSION = 1;

export const USAGE_SURFACES = ['cli', 'mcp', 'hook'] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];

export const USAGE_CALLERS = ['agent', 'human', 'hook-injected'] as const;
export type UsageCaller = (typeof USAGE_CALLERS)[number];

export const UNKNOWN_REASONS = [
  'not_captured',
  'transcript_expired',
  'unsupported_by_agent',
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** A value, or null with the reason it is unknown. Unknown is never zero. */
export type Captured<T> =
  | { value: T; reason?: undefined }
  | { value: null; reason: UnknownReason };

/** UsageEvent keys whose value may be null. */
export type UsageNullableField =
  | 'agent'
  | 'session_id'
  | 'parent_session_id'
  | 'git_head'
  | 'worktree'
  | 'query'
  | 'section_id'
  | 'injected_bytes'
  | 'found'
  | 'result_count'
  | 'bytes_out'
  | 'error_class';

/** One line of events-YYYY-MM.jsonl: a lat CLI command or MCP tool call. */
export interface UsageEvent {
  schema_version: typeof USAGE_SCHEMA_VERSION;
  event_id: string;
  ts: string;
  duration_ms: number;
  command: string;
  surface: UsageSurface;
  caller: UsageCaller;
  agent: string | null;
  lat_version: string;
  session_id: string | null;
  parent_session_id: string | null;
  repo_root: string;
  git_head: string | null;
  worktree: string | null;
  query: string | null;
  /** Ranked section ids; lat expand records its resolved ids here. */
  result_ids: string[];
  result_count: number | null;
  section_id: string | null;
  /**
   * Hook events only: byte length of every injected text the agent sees,
   * summed (additionalContext, permissionDecisionReason, the Stop reason,
   * Cursor's additional_context and followup_message, Antigravity's
   * ephemeralMessage steps).
   */
  injected_bytes: number | null;
  found: boolean | null;
  bytes_out: number | null;
  exit_code: number;
  error_class: string | null;
  /**
   * Every null field that is unknown, rather than not applicable (such as
   * query on a command that takes none), has an entry here.
   */
  unknown_reasons: Partial<Record<UsageNullableField, UnknownReason>>;
}

export const TOOL_ACTIONS = ['read', 'edit', 'search', 'shell'] as const;
export type ToolAction = (typeof TOOL_ACTIONS)[number];

interface ToolCallBase {
  name: string;
  /** Worktree-relative POSIX path; absolute when outside the worktree. */
  path: string | null;
  bytes: number | null;
}

export type ToolCall =
  | (ToolCallBase & {
      action: 'shell';
      shell: { command: string; exit_code: Captured<number> };
    })
  | (ToolCallBase & { action: Exclude<ToolAction, 'shell'>; shell?: never });

export type TokenCounter =
  | 'input'
  | 'output'
  | 'cache_read'
  | 'cache_write'
  | 'reasoning';

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
  /**
   * A null counter is unknown and has an entry here naming why. Readers that
   * report a counter set the number.
   */
  unknown_reasons?: Partial<Record<TokenCounter, UnknownReason>>;
  /**
   * Set only when the transcript reports a cost for this message, in US
   * dollars, as reported. Absent when the agent reports none. lat never
   * computes cost into this field; computed cost belongs to read time.
   */
  reported_cost_usd?: number;
}

export interface SessionEventBase {
  /** Derived from source path and offset: see sessionEventId. */
  event_id: string;
  session_id: string;
  /**
   * Set on every event of a subagent session, naming the session that spawned
   * it. Absent for top-level sessions, where it is not applicable.
   */
  parent_session_id?: string;
  ts: string;
  source: { path: string; offset: number };
}

/** Normalized output of every session reader. */
export type SessionEvent = SessionEventBase &
  (
    | { kind: 'session_start' }
    | { kind: 'session_end' }
    | { kind: 'session_name'; name: string }
    | { kind: 'model'; model: string }
    | { kind: 'tool_call'; tool: ToolCall }
    | { kind: 'token_usage'; usage: TokenUsage }
    | { kind: 'bypass_read'; path: string; bytes: number | null }
    | { kind: 'bd_command'; verb: 'claim' | 'close'; issue_id: string }
  );

export function sessionEventId(sourcePath: string, offset: number): string {
  return createHash('sha256')
    .update(`${sourcePath}\0${offset}`)
    .digest('hex')
    .slice(0, 16);
}

export function toWorktreeRelativePath(
  filePath: string,
  worktreeRoot: string,
): string {
  if (!isAbsolute(filePath)) return filePath.split(sep).join('/');
  const rel = relative(worktreeRoot, filePath);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    isAbsolute(rel)
  )
    return filePath;
  return rel.split(sep).join('/');
}
