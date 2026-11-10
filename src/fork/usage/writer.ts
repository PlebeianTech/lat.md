import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensureUsageDirectory } from './enabled.js';
import type { UsageEvent } from './schema.js';

export const MAX_EVENT_LINE_BYTES = 4096;

export function eventFilePath(root: string, ts: string): string {
  return join(root, '.lat', 'usage', `events-${ts.slice(0, 7)}.jsonl`);
}

function lineOf(event: UsageEvent): string {
  return JSON.stringify(event) + '\n';
}

function eventLine(event: UsageEvent): string | null {
  // Drop result ids from the end while they alone overflow the line, so a
  // long id list never costs the query. result_count keeps the true count.
  const result_ids = [...event.result_ids];
  while (
    result_ids.length > 0 &&
    Buffer.byteLength(lineOf({ ...event, query: null, result_ids })) >
      MAX_EVENT_LINE_BYTES
  )
    result_ids.pop();
  const fitted = { ...event, result_ids };
  let line = lineOf(fitted);
  const overflow = Buffer.byteLength(line) - MAX_EVENT_LINE_BYTES;
  if (overflow > 0 && fitted.query !== null) {
    const query = fitted.query.slice(
      0,
      Math.max(0, fitted.query.length - overflow),
    );
    line = lineOf({ ...fitted, query });
  }
  return Buffer.byteLength(line) <= MAX_EVENT_LINE_BYTES ? line : null;
}

/**
 * O_NOFOLLOW refuses a symlink planted at the events file. O_NONBLOCK and
 * the regular-file check stop a FIFO there from blocking the command.
 */
function appendLine(path: string, line: string): void {
  const {
    O_APPEND,
    O_CREAT,
    O_WRONLY,
    O_NOFOLLOW = 0,
    O_NONBLOCK = 0,
  } = constants;
  const flags = O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW | O_NONBLOCK;
  const fd = openSync(path, flags, 0o666);
  try {
    if (fstatSync(fd).isFile()) writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export function writeUsageEvent(root: string, event: UsageEvent): void {
  try {
    const line = eventLine(event);
    if (line === null) return;
    ensureUsageDirectory(root);
    appendLine(eventFilePath(root, event.ts), line);
  } catch {
    return;
  }
}
