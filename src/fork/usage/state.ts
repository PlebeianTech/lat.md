import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Captured,
  SessionEvent,
  SessionEventBase,
  ToolAction,
  UnknownReason,
  UsageEvent,
} from './schema.js';
import { existingUsageDirectory } from './enabled.js';
import type { Checkpoint } from './sources/types.js';

export const USAGE_STATE_VERSION = 2;

/**
 * A tool call without its shell command text. The epic stores pointers, not
 * copies of transcript text: a consumer that needs the command re-reads the
 * source line through `source` (path and offset) of the event.
 */
export interface SlimToolCall {
  name: string;
  action: ToolAction;
  path: string | null;
  bytes: number | null;
  shell?: { exit_code: Captured<number> };
}

export type SlimSessionEvent =
  | Exclude<SessionEvent, { kind: 'tool_call' }>
  | (SessionEventBase & { kind: 'tool_call'; tool: SlimToolCall });

function slim(event: SessionEvent): SlimSessionEvent {
  if (event.kind !== 'tool_call') return event;
  const { name, action, path, bytes, shell } = event.tool;
  return {
    ...event,
    tool: {
      name,
      action,
      path,
      bytes,
      ...(shell ? { shell: { exit_code: shell.exit_code } } : {}),
    },
  };
}

export interface StoredSessionEvent {
  /** The reader's agent: a SessionEvent does not carry it. */
  agent: string;
  event: SlimSessionEvent;
}

/**
 * Everything the aggregator keeps between runs, in
 * <root>/.lat/usage/state.json. The offsets say where to resume; the events
 * are what the earlier runs read, so a restart needs no re-read.
 */
export interface UsageState {
  version: typeof USAGE_STATE_VERSION;
  /** Byte offset after the last complete line read, by log file name. */
  logs: Record<string, number>;
  /** Reader checkpoint by session transcript path. */
  sources: Record<string, Checkpoint>;
  /** Why a reader supplied no data on its last read, by agent. */
  reasons: Record<string, UnknownReason | null>;
  /** By event_id. */
  usage: Record<string, UsageEvent>;
  /** By event_id, or by kind and session for the kinds in LATEST_WINS. */
  sessions: Record<string, StoredSessionEvent>;
}

/** Readers re-emit these on every resumed read, with new event ids. */
const LATEST_WINS = new Set(['session_end', 'model', 'session_name']);

export function emptyState(): UsageState {
  return {
    version: USAGE_STATE_VERSION,
    logs: {},
    sources: {},
    reasons: {},
    usage: {},
    sessions: {},
  };
}

export function statePath(root: string): string {
  return join(root, '.lat', 'usage', 'state.json');
}

/** A missing, unreadable or foreign state file starts from nothing. */
export function loadState(root: string): UsageState {
  try {
    const state = JSON.parse(readFileSync(statePath(root), 'utf-8'));
    return state?.version === USAGE_STATE_VERSION ? state : emptyState();
  } catch {
    return emptyState();
  }
}

/** Failing to save costs only a re-read on the next start, so it is silent. */
// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]
export function saveState(root: string, state: UsageState): void {
  try {
    if (existingUsageDirectory(root) === null) return;
    const temporary = `${statePath(root)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, statePath(root));
  } catch {
    return;
  }
}

/** Returns whether the state changed. */
export function addUsageEvent(state: UsageState, event: UsageEvent): boolean {
  if (event.event_id in state.usage) return false;
  state.usage[event.event_id] = event;
  return true;
}

function isNewer(
  candidate: SlimSessionEvent,
  current: SlimSessionEvent,
): boolean {
  const order = Date.parse(candidate.ts) - Date.parse(current.ts);
  return order !== 0 ? order > 0 : candidate.event_id > current.event_id;
}

/** Returns whether the state changed. */
export function addSessionEvent(
  state: UsageState,
  agent: string,
  event: SessionEvent,
): boolean {
  const key = LATEST_WINS.has(event.kind)
    ? `${event.kind}\0${event.session_id}`
    : event.event_id;
  const current = state.sessions[key];
  if (
    current &&
    !(LATEST_WINS.has(event.kind) && isNewer(event, current.event))
  )
    return false;
  state.sessions[key] = { agent, event: slim(event) };
  return true;
}
