import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contribution } from '../src/fork/usage/aggregate.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import type { FindingsResult } from '../src/fork/usage/findings.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type { SessionSource } from '../src/fork/usage/sources/types.js';
import { registerUsageCommand } from '../src/fork/usage/usage-cli.js';
import { gapLine } from '../src/fork/usage/usage-gaps-cli.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const DAY = 24 * 60;

let root: string;
function gitInit(dir: string): string {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', [
    '-C',
    dir,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
  return dir;
}

let counter = 0;
let output: string;
let neverRead: { id: string }[];
const sessionEvents: SessionEvent[] = [];

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
    result_count: 0,
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

function sessionEvent(fields: Record<string, unknown>): SessionEvent {
  counter++;
  return {
    event_id: `s${counter}`,
    session_id: 'A',
    ts: at(0),
    source: { path: '/fake/A.jsonl', offset: counter },
    ...fields,
  } as SessionEvent;
}

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

const knowledge: Contribution = {
  key: 'knowledge',
  compute: () => ({
    never_read_sections: neverRead,
    snapshot: { sections: neverRead },
  }),
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
    contributions: [knowledge],
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await program.parseAsync(['--dir', root, 'usage', 'gaps', ...args], {
    from: 'user',
  });
  return output;
}

async function runJson(...args: string[]): Promise<FindingsResult> {
  return JSON.parse(await run(...args, '--json')) as FindingsResult;
}

beforeEach(() => {
  counter = 0;
  neverRead = [];
  sessionEvents.length = 0;
  root = gitInit(mkdtempSync(join(tmpdir(), 'lat-usage-gaps-')));
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

/** Two sessions of two agents, spread over two days, each with a claim. */
function seed() {
  for (const event of [
    usage({ session_id: 'A', ts: at(0), query: 'cache eviction' }),
    usage({ session_id: 'A', ts: at(1), query: 'Cache eviction' }),
    usage({
      session_id: 'B',
      agent: 'codex',
      ts: at(DAY),
      query: 'cache eviction',
    }),
  ])
    writeUsageEvent(root, event);
  sessionEvents.push(
    sessionEvent({
      kind: 'bd_command',
      verb: 'claim',
      issue_id: 'lat-1.1',
      ts: at(-1),
    }),
    sessionEvent({
      kind: 'bd_command',
      verb: 'claim',
      issue_id: 'lat-2',
      session_id: 'B',
      ts: at(-1),
    }),
  );
}

// @lat: [[usage-gaps-cli#Usage Gaps CLI#Text output lists each finding kind]]
describe('lat usage gaps text output', () => {
  it('prints one line per finding kind', async () => {
    writeUsageEvent(root, usage({ ts: at(0), query: 'cache eviction policy' }));
    sessionEvents.push(
      sessionEvent({
        kind: 'bypass_read',
        path: 'lat.md/cli.md',
        bytes: 3,
        ts: at(2),
      }),
    );
    neverRead = [{ id: 'cli#CLI#Eviction policy' }];
    const lines = (await run()).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines).toContain(
      'empty-search  cache eviction policy  count 1, sessions 1  closest: Eviction policy (cli#CLI#Eviction policy)',
    );
    expect(lines).toContain(
      'bypassed-file  lat.md/cli.md  count 1, sessions 1',
    );
    expect(lines).toContain(
      'never-read-section  cli#CLI#Eviction policy  count 1, sessions 0',
    );
  });
});

// @lat: [[usage-gaps-cli#Usage Gaps CLI#The json output holds the full findings]]
describe('lat usage gaps --json', () => {
  it('prints the findings record shape of the live endpoint', async () => {
    seed();
    neverRead = [{ id: 'cli#CLI#Eviction' }];
    const body = await runJson();
    expect(body).toMatchObject({
      schema_version: USAGE_SCHEMA_VERSION,
      errors: [],
    });
    const empty = body.findings.find((f) => f.kind === 'empty-search')!;
    expect(Object.keys(empty).sort()).toEqual(
      [
        'count',
        'daily',
        'evidence',
        'first_seen',
        'id',
        'kind',
        'last_seen',
        'sessions',
        'subject',
        'suggestion',
      ].sort(),
    );
    expect(empty).toMatchObject({
      subject: 'cache eviction',
      count: 3,
      sessions: 2,
    });
    expect(empty.evidence).toHaveLength(3);
    expect(body.findings.map((f) => f.kind)).toContain('never-read-section');
  });
});

// @lat: [[usage-gaps-cli#Usage Gaps CLI#Each filter narrows the gaps]]
describe('lat usage gaps filters', () => {
  const countOf = async (...args: string[]) =>
    (await runJson(...args)).findings.find((f) => f.kind === 'empty-search')
      ?.count ?? 0;

  it('--agent narrows to one agent', async () => {
    seed();
    expect(await countOf()).toBe(3);
    expect(await countOf('--agent', 'codex')).toBe(1);
  });

  it('--session narrows to one session', async () => {
    seed();
    expect(await countOf('--session', 'A')).toBe(2);
  });

  it('--issue includes descendants', async () => {
    seed();
    expect(await countOf('--issue', 'lat-1')).toBe(2);
    expect(await countOf('--issue', 'lat-2')).toBe(1);
  });

  it('--since becomes the from filter', async () => {
    seed();
    expect(await countOf('--since', '2026-11-09')).toBe(1);
  });

  it('rejects an invalid --since date with the parser message', async () => {
    seed();
    await expect(run('--since', 'nope')).rejects.toThrow(
      'Invalid from date: nope',
    );
  });
});

// @lat: [[usage-gaps-cli#Usage Gaps CLI#An empty result says so in one line]]
describe('lat usage gaps with nothing to report', () => {
  it('prints one line', async () => {
    seed();
    const text = await run('--agent', 'nobody');
    expect(text).toBe('No gaps found for these filters.\n');
  });
});

// @lat: [[usage-gaps-cli#Usage Gaps CLI#Long lists and detector errors stay short]]
describe('lat usage gaps limits', () => {
  it('shows twenty findings and counts the rest', async () => {
    for (let i = 0; i < 23; i++)
      writeUsageEvent(root, usage({ ts: at(i), query: `topic${i}` }));
    const lines = (await run()).trimEnd().split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('... 3 more (use --json)');
    expect((await runJson()).findings).toHaveLength(23);
  });

  it('names a detector that failed', async () => {
    seed();
    const throwing: Contribution = {
      key: 'knowledge',
      compute: () => ({
        get never_read_sections(): never {
          throw new Error('boom');
        },
      }),
    };
    output = '';
    const program = new Command().option('--dir <path>').exitOverride();
    registerUsageCommand(program, {
      sources: [fakeSource],
      bd: { refresh: async () => snapshot },
      contributions: [throwing],
    });
    await program.parseAsync(['--dir', root, 'usage', 'gaps'], {
      from: 'user',
    });
    expect(output).toContain('Detector never-read-section failed: boom');
    expect(output).toContain('empty-search  cache eviction');
  });
});

// @lat: [[usage-gaps-cli#Usage Gaps CLI#A search miss names its expected section]]
describe('lat usage gaps search-miss line', () => {
  it('prints the expected section of a search miss', () => {
    const line = gapLine({
      kind: 'search-miss',
      id: 'search-miss:cache eviction|lat.md/cache#Cache#Eviction',
      subject: 'cache eviction',
      count: 2,
      sessions: 1,
      first_seen: null,
      last_seen: null,
      daily: [],
      evidence: [],
      suggestion: null,
      expected_section_id: 'lat.md/cache#Cache#Eviction',
    });
    expect(line).toBe(
      'search-miss  cache eviction  count 2, sessions 1  expected: lat.md/cache#Cache#Eviction',
    );
  });
});
