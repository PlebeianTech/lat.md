import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UnknownReason, UsageEvent } from './schema.js';
import type { SessionSource } from './sources/types.js';
import { addSessionEvent, addUsageEvent, type UsageState } from './state.js';

const LOG_FILE = /^events-\d{4}-\d{2}\.jsonl$/;

/** A stored line is trusted only for the fields aggregation reads. */
function parseUsageLine(line: string): UsageEvent | null {
  try {
    const event = JSON.parse(line);
    return typeof event?.event_id === 'string' &&
      typeof event.command === 'string' &&
      typeof event.ts === 'string' &&
      !Number.isNaN(Date.parse(event.ts)) &&
      Array.isArray(event.result_ids)
      ? event
      : null;
  } catch {
    return null;
  }
}

/** Reads the complete lines after the stored offset; returns whether any were new. */
export function readLog(root: string, state: UsageState): boolean {
  const dir = join(root, '.lat', 'usage');
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => LOG_FILE.test(name))
      .sort();
  } catch {
    return false;
  }
  let changed = false;
  for (const name of names) {
    const path = join(dir, name);
    let offset = state.logs[name] ?? 0;
    let buffer: Buffer;
    try {
      const size = statSync(path).size;
      if (size < offset) offset = 0;
      if (size === offset) continue;
      buffer = Buffer.alloc(size - offset);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const complete = buffer.lastIndexOf(0x0a) + 1;
    for (const line of buffer
      .subarray(0, complete)
      .toString('utf-8')
      .split('\n')) {
      const event = line === '' ? null : parseUsageLine(line);
      if (event && addUsageEvent(state, event)) changed = true;
    }
    if (state.logs[name] !== offset + complete) changed = true;
    state.logs[name] = offset + complete;
  }
  return changed;
}

export async function readSessions(
  root: string,
  sources: SessionSource[],
  state: UsageState,
): Promise<boolean> {
  let changed = false;
  for (const source of sources) {
    let reason: UnknownReason | null = null;
    for (const path of await source.discover(root)) {
      const result = await source.read(path, state.sources[path] ?? null);
      reason = reason ?? result.reason;
      if (
        JSON.stringify(state.sources[path]) !==
        JSON.stringify(result.checkpoint)
      )
        changed = true;
      state.sources[path] = result.checkpoint;
      for (const event of result.events)
        if (addSessionEvent(state, source.agent, event)) changed = true;
    }
    if ((state.reasons[source.agent] ?? null) !== reason) changed = true;
    state.reasons[source.agent] = reason;
  }
  return changed;
}
