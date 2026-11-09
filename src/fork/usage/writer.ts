import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureUsageDirectory } from './enabled.js';
import type { UsageEvent } from './schema.js';

export const MAX_EVENT_LINE_BYTES = 4096;

export function eventFilePath(root: string, ts: string): string {
  return join(root, '.lat', 'usage', `events-${ts.slice(0, 7)}.jsonl`);
}

function eventLine(event: UsageEvent): string | null {
  let line = JSON.stringify(event) + '\n';
  const overflow = Buffer.byteLength(line) - MAX_EVENT_LINE_BYTES;
  if (overflow > 0 && event.query !== null) {
    const query = event.query.slice(
      0,
      Math.max(0, event.query.length - overflow),
    );
    line = JSON.stringify({ ...event, query }) + '\n';
  }
  return Buffer.byteLength(line) <= MAX_EVENT_LINE_BYTES ? line : null;
}

export function writeUsageEvent(root: string, event: UsageEvent): void {
  try {
    const line = eventLine(event);
    if (line === null) return;
    ensureUsageDirectory(root);
    appendFileSync(eventFilePath(root, event.ts), line);
  } catch {
    return;
  }
}
