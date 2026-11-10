import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirBestEffort } from './util.js';
import {
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import {
  MAX_EVENT_LINE_BYTES,
  eventFilePath,
  writeUsageEvent,
} from '../src/fork/usage/writer.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(rmDirBestEffort));

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-usage-writer-'));
  roots.push(root);
  return root;
}

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: 'id-1',
    ts: '2026-11-08T10:00:00.000Z',
    duration_ms: 5,
    command: 'search',
    surface: 'cli',
    caller: 'human',
    agent: null,
    lat_version: '0.0.0',
    session_id: null,
    parent_session_id: null,
    repo_root: '/repo',
    git_head: null,
    worktree: null,
    query: 'hello',
    result_ids: [],
    result_count: 0,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: 0,
    exit_code: 0,
    error_class: null,
    unknown_reasons: {},
    ...overrides,
  };
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean);
}

// @lat: [[usage-tap#Usage Tap#Events append to a monthly file]]
describe('writeUsageEvent', () => {
  it('appends one line per event to the month file of the event timestamp', () => {
    const root = makeRoot();
    writeUsageEvent(root, makeEvent({ event_id: 'a' }));
    writeUsageEvent(root, makeEvent({ event_id: 'b' }));
    writeUsageEvent(
      root,
      makeEvent({ event_id: 'c', ts: '2026-12-01T00:00:00.000Z' }),
    );
    const november = eventFilePath(root, '2026-11-08T10:00:00.000Z');
    expect(
      november.endsWith(join('.lat', 'usage', 'events-2026-11.jsonl')),
    ).toBe(true);
    expect(readLines(november).map((l) => JSON.parse(l).event_id)).toEqual([
      'a',
      'b',
    ]);
    expect(
      readLines(eventFilePath(root, '2026-12-01T00:00:00.000Z')),
    ).toHaveLength(1);
  });

  // @lat: [[usage-tap#Usage Tap#The usage directory ignores itself]]
  it('writes a gitignore holding a single asterisk and keeps it on later writes', () => {
    const root = makeRoot();
    writeUsageEvent(root, makeEvent());
    writeUsageEvent(root, makeEvent());
    expect(
      readFileSync(join(root, '.lat', 'usage', '.gitignore'), 'utf-8'),
    ).toBe('*\n');
  });

  // @lat: [[usage-tap#Usage Tap#Lines stay under 4 KB]]
  it('truncates the query so every line stays under the limit', () => {
    const root = makeRoot();
    writeUsageEvent(root, makeEvent({ query: 'x'.repeat(10_000) }));
    const [line] = readLines(eventFilePath(root, '2026-11-08T10:00:00.000Z'));
    expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(
      MAX_EVENT_LINE_BYTES,
    );
    const parsed = JSON.parse(line);
    expect(parsed.query.length).toBeGreaterThan(1000);
    expect(parsed.query.length).toBeLessThan(10_000);
  });

  // @lat: [[usage-tap#Usage Tap#Lines stay under 4 KB]]
  it('drops result ids from the end, keeping the query and the true result_count', () => {
    const root = makeRoot();
    const ids = Array.from(
      { length: 75 },
      (_, i) =>
        `lat.md/some/long/path#Some Long Heading#Subsection number ${i}`,
    );
    writeUsageEvent(root, makeEvent({ result_ids: ids, result_count: 75 }));
    const lines = readLines(eventFilePath(root, '2026-11-08T10:00:00.000Z'));
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]) + 1).toBeLessThanOrEqual(
      MAX_EVENT_LINE_BYTES,
    );
    const parsed = JSON.parse(lines[0]) as UsageEvent;
    expect(parsed.result_count).toBe(75);
    expect(parsed.query).toBe('hello');
    expect(parsed.result_ids.length).toBeGreaterThan(0);
    expect(parsed.result_ids).toEqual(ids.slice(0, parsed.result_ids.length));
  });

  // @lat: [[usage-tap#Usage Tap#A failing write is silent]]
  it('returns silently when the usage directory is read-only', () => {
    const root = makeRoot();
    const dir = join(root, '.lat', 'usage');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      expect(() => writeUsageEvent(root, makeEvent())).not.toThrow();
      expect(existsSync(eventFilePath(root, '2026-11-08T10:00:00.000Z'))).toBe(
        false,
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // @lat: [[usage-tap#Usage Tap#A failing write is silent]]
  it.skipIf(process.platform === 'win32')(
    'returns at once when the events file is a FIFO with no reader',
    () => {
      const root = makeRoot();
      mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
      execFileSync('mkfifo', [eventFilePath(root, '2026-11-08T10:00:00.000Z')]);
      // A child process, so a blocking open fails the test instead of hanging it.
      const script = `
        import { writeUsageEvent } from ${JSON.stringify(join(import.meta.dirname, '../src/fork/usage/writer.ts'))};
        writeUsageEvent(${JSON.stringify(root)}, ${JSON.stringify(makeEvent())});
      `;
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: 'ignore', timeout: 20_000 },
      );
      expect(child.signal).toBeNull();
      expect(child.status).toBe(0);
    },
    30_000,
  );

  // @lat: [[usage-tap#Usage Tap#Concurrent writers never interleave]]
  it('keeps whole parseable lines when 20 processes write at once', async () => {
    const root = makeRoot();
    const script = `
      import { writeUsageEvent } from ${JSON.stringify(join(import.meta.dirname, '../src/fork/usage/writer.ts'))};
      const event = ${JSON.stringify(makeEvent({ query: 'q'.repeat(3000) }))};
      for (let i = 0; i < 20; i++)
        writeUsageEvent(${JSON.stringify(root)}, { ...event, event_id: process.pid + '-' + i });
    `;
    await Promise.all(
      Array.from(
        { length: 20 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--import', 'tsx', '--input-type=module', '-e', script],
              { stdio: 'ignore' },
            );
            child.on('error', reject);
            child.on('exit', (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`writer exited ${code}`)),
            );
          }),
      ),
    );
    const lines = readLines(eventFilePath(root, '2026-11-08T10:00:00.000Z'));
    expect(lines).toHaveLength(400);
    const ids = lines.map((l) => JSON.parse(l).event_id);
    expect(new Set(ids).size).toBe(400);
  }, 60_000);
});

// @lat: [[usage-tap#Usage Tap#Symlinks in the usage directory are never followed]]
describe('writeUsageEvent with planted symlinks', () => {
  const ts = '2026-11-08T10:00:00.000Z';

  function outsideFile(): string {
    const path = join(makeRoot(), 'zshrc');
    writeFileSync(path, 'original\n');
    return path;
  }

  it('does not append through a symlinked events file', () => {
    const root = makeRoot();
    const target = outsideFile();
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    symlinkSync(target, eventFilePath(root, ts));
    expect(() => writeUsageEvent(root, makeEvent())).not.toThrow();
    expect(readFileSync(target, 'utf-8')).toBe('original\n');
  });

  it('writes nothing when .lat/usage is a symlink', () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(root, '.lat'));
    symlinkSync(outside, join(root, '.lat', 'usage'));
    expect(() => writeUsageEvent(root, makeEvent())).not.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('writes nothing when .lat is a symlink', () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(outside, 'usage'));
    symlinkSync(outside, join(root, '.lat'));
    expect(() => writeUsageEvent(root, makeEvent())).not.toThrow();
    expect(readdirSync(join(outside, 'usage'))).toEqual([]);
  });
});
