import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageSummary } from '../src/fork/usage/aggregate.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import * as filters from '../src/fork/usage/filters.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type { SessionSource } from '../src/fork/usage/sources/types.js';
import { registerUsageCommand } from '../src/fork/usage/usage-cli.js';
import { usageEnabled } from '../src/fork/usage/enabled.js';
import { eventFilePath, writeUsageEvent } from '../src/fork/usage/writer.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const DAY = 24 * 60;

let root: string;
let counter = 0;
let output: string;

function usage(fields: Partial<UsageEvent>): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${counter}`,
    ts: at(0),
    duration_ms: 10,
    command: 'search',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: '/repo',
    git_head: null,
    worktree: null,
    query: 'q',
    result_ids: [],
    result_count: 1,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: 0,
    error_class: null,
    unknown_reasons: {},
    ...fields,
  };
}

function claim(sessionId: string, issueId: string): SessionEvent {
  counter++;
  return {
    kind: 'bd_command',
    event_id: `s${counter}`,
    session_id: sessionId,
    ts: at(-1),
    source: { path: `/fake/${sessionId}.jsonl`, offset: counter },
    verb: 'claim',
    issue_id: issueId,
  } as SessionEvent;
}

const sessionEvents: SessionEvent[] = [];
const fakeSource: SessionSource = {
  agent: 'claude',
  discover: async () => ['/fake/claude.jsonl'],
  read: async () => ({
    events: sessionEvents,
    checkpoint: { offset: sessionEvents.length },
    reason: null,
  }),
};

const issue = (id: string, parent?: string) => ({
  id,
  title: `title ${id}`,
  status: 'open',
  issue_type: parent ? 'task' : 'epic',
  created_at: at(-1000),
  ...(parent ? { parent } : {}),
});
const snapshot: BdSnapshot = {
  issues: [issue('lat-1'), issue('lat-1.1', 'lat-1'), issue('lat-2')],
  discoveredFrom: [],
  reopens: [],
};

async function run(...args: string[]): Promise<string> {
  output = '';
  const program = new Command()
    .option('--dir <path>')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerUsageCommand(program, {
    sources: [fakeSource],
    bd: { refresh: async () => snapshot },
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await program.parseAsync(['--dir', root, 'usage', ...args], {
    from: 'user',
  });
  return output;
}

async function runJson(...args: string[]): Promise<UsageSummary> {
  return JSON.parse(await run(...args, '--json')) as UsageSummary;
}

beforeEach(() => {
  counter = 0;
  sessionEvents.length = 0;
  root = mkdtempSync(join(tmpdir(), 'lat-usage-cli-'));
  mkdirSync(join(root, 'lat.md'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...parts) => {
    output += parts.join(' ') + '\n';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function seed() {
  const events = [
    usage({ session_id: 'A', agent: 'claude', ts: at(0) }),
    usage({ session_id: 'A', agent: 'claude', ts: at(1) }),
    usage({ session_id: 'B', agent: 'codex', ts: at(DAY) }),
  ];
  for (const event of events) writeUsageEvent(root, event);
  sessionEvents.push(claim('A', 'lat-1.1'), claim('B', 'lat-2'));
}

// @lat: [[usage-cli#Usage CLI#Enable and disable toggle the usage directory]]
describe('lat usage enable and disable', () => {
  it('creates <root>/.lat/usage/ and is safe to repeat', async () => {
    const dir = join(root, '.lat', 'usage');
    await run('enable');
    expect(existsSync(dir)).toBe(true);
    expect(usageEnabled(root)).toBe(true);
    await run('enable');
    expect(existsSync(dir)).toBe(true);
    await run('disable');
    await run('disable');
    expect(existsSync(dir)).toBe(false);
  });
});

// @lat: [[usage-cli#Usage CLI#Disable keeps the recorded events]]
describe('lat usage disable keeps history', () => {
  const kept = () => join(root, '.lat', 'usage.disabled');

  it('moves events to .lat/usage.disabled and enable restores them', async () => {
    const event = usage({ ts: at(0) });
    writeUsageEvent(root, event);
    const file = eventFilePath(root, event.ts);
    const name = basename(file);
    expect(usageEnabled(root)).toBe(true);

    const text = await run('disable');
    expect(usageEnabled(root)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(kept(), name))).toBe(true);
    expect(readFileSync(join(kept(), '.gitignore'), 'utf-8')).toBe('*\n');
    expect(text).toContain('Kept 1 event files in .lat/usage.disabled');
    expect(text).toContain('Usage tracking is off.');

    const restored = await run('enable');
    expect(usageEnabled(root)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(kept())).toBe(false);
    expect(restored).toContain('Restored 1 event files');
  });

  it('refuses when .lat/usage.disabled already exists', async () => {
    const event = usage({ ts: at(0) });
    writeUsageEvent(root, event);
    const name = basename(eventFilePath(root, event.ts));
    mkdirSync(kept(), { recursive: true });
    writeFileSync(join(kept(), name), 'old\n');
    const text = await run('disable');
    expect(text).toContain('Not disabled');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(usageEnabled(root)).toBe(true);
    expect(existsSync(eventFilePath(root, event.ts))).toBe(true);
    expect(readFileSync(join(kept(), name), 'utf-8')).toBe('old\n');
  });

  it('enable with both directories changes nothing and exits 0', async () => {
    const event = usage({ ts: at(0) });
    writeUsageEvent(root, event);
    const name = basename(eventFilePath(root, event.ts));
    mkdirSync(kept(), { recursive: true });
    writeFileSync(join(kept(), name), 'old\n');
    const text = await run('enable');
    expect(text).toContain('Already enabled');
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(eventFilePath(root, event.ts))).toBe(true);
    expect(readFileSync(join(kept(), name), 'utf-8')).toBe('old\n');
  });

  it('reports a failed rename, exits 1 and moves nothing', async () => {
    const event = usage({ ts: at(0) });
    writeUsageEvent(root, event);
    const lat = join(root, '.lat');
    chmodSync(lat, 0o555);
    try {
      const text = await run('disable');
      expect(text).toContain(join(lat, 'usage'));
      expect(text).toContain(kept());
      expect(text).toContain('Nothing was changed');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      chmodSync(lat, 0o755);
    }
    expect(existsSync(eventFilePath(root, event.ts))).toBe(true);
    expect(existsSync(kept())).toBe(false);
    expect(usageEnabled(root)).toBe(true);
  });

  it('says so when LAT_USAGE=1 keeps tracking on', async () => {
    vi.stubEnv('LAT_USAGE', '1');
    writeUsageEvent(root, usage({ ts: at(0) }));
    const text = await run('disable');
    expect(text).toContain('off for this project, but LAT_USAGE=1 still');
    vi.unstubAllEnvs();
  });
});

// @lat: [[usage-cli#Usage CLI#Enable refuses a symlinked usage directory]]
describe('lat usage enable with a planted symlink', () => {
  for (const name of ['.lat', '.lat/usage', '.lat/usage.disabled']) {
    it(`refuses when ${name} is a symlink and changes nothing`, async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      if (name !== '.lat') mkdirSync(join(root, '.lat'));
      symlinkSync(outside, join(root, name));
      const text = await run('enable');
      expect(text).toBe(
        `Not enabled: ${join(root, name)} is a symlink. Remove it, then run again.\n`,
      );
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      expect(readdirSync(outside)).toEqual([]);
    });
  }
});

// @lat: [[usage-cli#Usage CLI#Disable refuses a symlinked usage directory]]
describe('lat usage disable with a planted symlink', () => {
  for (const name of ['.lat', '.lat/usage', '.lat/usage.disabled']) {
    it(`refuses when ${name} is a symlink and moves nothing`, async () => {
      const outside = join(root, 'outside');
      mkdirSync(join(outside, 'usage'), { recursive: true });
      if (name !== '.lat') mkdirSync(join(root, '.lat'));
      if (name === '.lat/usage.disabled') mkdirSync(join(root, '.lat/usage'));
      symlinkSync(outside, join(root, name));
      const text = await run('disable');
      expect(text).toBe(
        `Not disabled: ${join(root, name)} is a symlink. Remove it, then run again.\n`,
      );
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      expect(readdirSync(outside)).toEqual(['usage']);
    });
  }
});

// @lat: [[usage-cli#Usage CLI#Each filter narrows the output]]
describe('lat usage filters', () => {
  it('narrows by agent, session, issue and since', async () => {
    seed();
    expect((await runJson()).totals.commands).toBe(3);
    expect((await runJson('--agent', 'codex')).totals.commands).toBe(1);
    expect((await runJson('--session', 'A')).totals.commands).toBe(2);
    expect((await runJson('--issue', 'lat-2')).totals.commands).toBe(1);
    expect((await runJson('--since', '2026-11-09')).totals.commands).toBe(1);
  });

  it('includes descendants of an epic', async () => {
    seed();
    expect((await runJson('--issue', 'lat-1.1')).totals.commands).toBe(2);
    expect((await runJson('--issue', 'lat-1')).totals.commands).toBe(2);
  });

  it('maps --since onto from', async () => {
    seed();
    expect((await runJson('--since', '2026-11-09')).filters).toEqual({
      from: '2026-11-09',
    });
  });
});

// @lat: [[usage-cli#Usage CLI#Filters go through parseUsageFilters]]
describe('lat usage filter parsing', () => {
  it('passes the flags to parseUsageFilters', async () => {
    seed();
    const spy = vi.spyOn(filters, 'parseUsageFilters');
    await run('--agent', 'claude', '--since', '2026-11-08');
    expect(spy).toHaveBeenCalledWith({
      agent: 'claude',
      session: undefined,
      issue: undefined,
      from: '2026-11-08',
    });
  });

  it('fails on an invalid --since date', async () => {
    seed();
    await expect(run('--since', 'yesterday')).rejects.toThrow(/from/);
  });
});

// @lat: [[usage-cli#Usage CLI#The json output is the aggregate summary]]
describe('lat usage --json', () => {
  it('prints the whole summary with its extensions', async () => {
    seed();
    const summary = await runJson();
    expect(summary.totals.commands).toBe(3);
    expect(summary.issues.map((row) => row.key)).toContain('lat-1.1');
    expect(Object.keys(summary.extensions)).toEqual(
      expect.arrayContaining(['knowledge', 'savings']),
    );
    expect(summary).toHaveProperty('schema_version', USAGE_SCHEMA_VERSION);
  });
});

// @lat: [[usage-cli#Usage CLI#The text output shows unknown as unknown]]
describe('lat usage text output', () => {
  it('shows unknown values as unknown, not 0', async () => {
    seed();
    writeUsageEvent(
      root,
      usage({ command: 'section', section_id: 'a#B', bytes_out: null }),
    );
    sessionEvents.push({
      kind: 'token_usage',
      event_id: 'tok1',
      session_id: 'A',
      ts: at(2),
      source: { path: '/fake/A.jsonl', offset: 99 },
      usage: {
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        reasoning: null,
      },
    } as SessionEvent);
    const text = await run();
    expect(text).toContain('Commands: 4');
    expect(text).toMatch(/Tokens saved: unknown/);
    expect(text).toMatch(/Input tokens: unknown/);
  });
});

// @lat: [[usage-cli#Usage CLI#The text output shows savings as a labelled range]]
describe('lat usage savings line', () => {
  it('prints a range with method version and the correlation label', async () => {
    seed();
    const summary = await runJson();
    const savings = summary.extensions.savings as Record<string, unknown>;
    savings.net_tokens_saved = { low: 10, point: 20, high: 30 };
    savings.reason = null;
    // re-render through the text path with a known estimate
    const { renderUsageSummary } =
      await import('../src/fork/usage/usage-cli.js');
    const text = renderUsageSummary(summary);
    expect(text).toContain('Tokens saved: 10 to 30 (point 20)');
    expect(text).toContain('method v1');
    expect(text).toContain('correlation, not cause');
  });

  it('shows how many reads the range leaves out as unknown', async () => {
    seed();
    const summary = await runJson();
    const savings = summary.extensions.savings as Record<string, unknown>;
    savings.net_tokens_saved = { low: 10, point: 20, high: 30 };
    savings.saved_bytes = { total: 100, known: 1, unknown: 3 };
    savings.unknown_reads = [
      { reason: 'a', count: 2 },
      { reason: 'b', count: 1 },
    ];
    const { renderUsageSummary } =
      await import('../src/fork/usage/usage-cli.js');
    expect(renderUsageSummary(summary)).toContain(
      'Tokens saved: 10 to 30 (+3 reads unknown) (point 20)',
    );
  });

  it('does not count a hook of unknown injected size as an unknown read', async () => {
    writeUsageEvent(
      root,
      usage({ command: 'hook', caller: 'hook-injected', injected_bytes: 30 }),
    );
    writeUsageEvent(
      root,
      usage({ command: 'hook', caller: 'hook-injected', injected_bytes: null }),
    );
    const summary = await runJson();
    const savings = summary.extensions.savings as {
      unknown_reads: { reason: string; count: number }[];
    };
    expect(savings.unknown_reads).toEqual([
      { reason: 'injected_bytes not captured', count: 1 },
    ]);
    const text = await run();
    expect(text).toContain('Tokens saved: -10 to -6 (point -7)');
    expect(text).not.toContain('reads unknown');
  });
});

// @lat: [[usage-cli#Usage CLI#Issue rows are not summed]]
describe('lat usage issue lines', () => {
  it('lists issues with a not-additive note and no total', async () => {
    seed();
    const text = await run();
    expect(text).toContain('lat-1.1');
    expect(text).toContain('lat-2');
    expect(text).toContain('rows overlap; not additive');
    expect(text).not.toMatch(/Issues total/i);
  });
});

// @lat: [[usage-cli#Usage CLI#Issue rows are not summed]]
describe('lat usage issue lines terminal safety', () => {
  it('strips control characters from an issue key', async () => {
    seed();
    const summary = await runJson();
    summary.issues[0].key = 'lat-1\x1b]0;pwned\x07';
    const { renderUsageSummary } =
      await import('../src/fork/usage/usage-cli.js');
    const text = renderUsageSummary(summary);
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(text).toContain('lat-1 ]0;pwned');
  });
});
