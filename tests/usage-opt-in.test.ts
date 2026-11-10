import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ events: [] as unknown[], reads: 0 }));
vi.mock('../src/fork/usage/sources/index.js', () => ({
  sessionSources: [
    {
      agent: 'claude',
      discover: async () => ['/fake/claude.jsonl'],
      read: async () => {
        fake.reads++;
        return {
          events: fake.events,
          checkpoint: { offset: fake.events.length },
          reason: null,
        };
      },
    },
  ],
}));

import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { createAggregator } from '../src/fork/usage/aggregate.js';
import { queryUsageEvents } from '../src/fork/usage/event-index.js';
import {
  forgetSnapshots,
  snapshotAt,
} from '../src/fork/usage/graph-snapshot.js';
import { configureUsageLive, stopUsageLive } from '../src/fork/usage/live.js';
import { registerUsageTool } from '../src/fork/usage/mcp-usage-tool.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import { readLog } from '../src/fork/usage/ingest.js';
import {
  addUsageEvent,
  saveState,
  emptyState,
  forgetStateWarning,
  loadState,
  statePath,
  USAGE_STATE_VERSION,
} from '../src/fork/usage/state.js';
import { usageEnabled } from '../src/fork/usage/enabled.js';
import { registerUsageCommand } from '../src/fork/usage/usage-cli.js';
import { startViewServer } from '../src/view/server.js';

const usageDir = (root: string) => join(root, '.lat', 'usage');
const latDir = (root: string) => join(root, '.lat');

function tokens(id: string): SessionEvent {
  return {
    kind: 'token_usage',
    event_id: id,
    session_id: 'A',
    ts: '2026-11-08T10:00:00Z',
    source: { path: '/fake/claude.jsonl', offset: 1 },
    usage: {
      input: 10,
      output: 5,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    },
  } as SessionEvent;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf-8' },
  ).trim();
}

let root: string;
let output: string;
let errors: string;

beforeEach(() => {
  vi.stubEnv('LAT_USAGE', '');
  forgetStateWarning();
  fake.events = [tokens('t1')];
  fake.reads = 0;
  forgetSnapshots();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-optin-')));
  mkdirSync(join(root, 'lat.md'));
  writeFileSync(join(root, 'lat.md', 'notes.md'), '# Notes\n\nText.\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  output = '';
  errors = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...parts) => {
    output += parts.join(' ') + '\n';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function lat(...args: string[]): Promise<string> {
  output = '';
  const program = new Command()
    .option('--dir <path>')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerUsageCommand(program, {
    bd: { refresh: async () => null },
    contributions: [],
  });
  await program.parseAsync(['--dir', root, 'usage', ...args], {
    from: 'user',
  });
  return output;
}

describe('reading usage never opts a project in', () => {
  // @lat: [[usage-opt-in#Usage Opt-in#The aggregator reads nothing and writes nothing when off]]
  it('the aggregator reads no session store and creates nothing', async () => {
    const aggregator = await createAggregator({
      root,
      bd: { refresh: async () => null },
    });
    const summary = await aggregator.summary();
    expect(summary.totals.tokens.messages).toBe(0);
    expect(fake.reads).toBe(0);
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#The aggregator runs no bd when off]]
  it('the aggregator runs no bd while off and runs it once usage is on', async () => {
    const refresh = vi.fn(async () => null);
    const aggregator = await createAggregator({ root, bd: { refresh } });
    await aggregator.summary();
    await aggregator.refresh();
    expect(refresh).not.toHaveBeenCalled();
    vi.stubEnv('LAT_USAGE', '1');
    await aggregator.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await aggregator.summary()).totals.tokens.messages).toBe(1);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#LAT_USAGE alone keeps state in memory]]
  it('with LAT_USAGE=1 and no directory it reads but keeps state in memory', async () => {
    vi.stubEnv('LAT_USAGE', '1');
    const aggregator = await createAggregator({
      root,
      bd: { refresh: async () => null },
    });
    const summary = await aggregator.summary();
    expect(summary.totals.tokens.messages).toBe(1);
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Graph snapshots are built without a cache when off]]
  it('builds a graph snapshot without creating a cache directory', async () => {
    const head = git(root, 'rev-parse', 'HEAD');
    const result = await snapshotAt(root, head, []);
    expect(result.reason).toBeNull();
    expect(result.snapshot?.git_head).toBe(head);
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#The raw event index reads nothing when off]]
  it('the raw event index reads no session store and creates nothing', async () => {
    const page = await queryUsageEvents(
      {},
      { root, bd: { refresh: async () => null } },
    );
    expect(page.records).toEqual([]);
    expect(fake.reads).toBe(0);
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#The raw event index runs no bd when off]]
  it('the raw event index runs no bd while off and runs it once usage is on', async () => {
    const refresh = vi.fn(async () => null);
    await queryUsageEvents({}, { root, bd: { refresh } });
    expect(refresh).not.toHaveBeenCalled();
    vi.stubEnv('LAT_USAGE', '1');
    const page = await queryUsageEvents({}, { root, bd: { refresh } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(page.records).toHaveLength(1);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#lat usage says tracking is not enabled]]
  it('lat usage says tracking is not enabled, exits 0 and creates nothing', async () => {
    const text = await lat();
    expect(text).toContain(
      'Usage tracking is not enabled; run `lat usage enable` to turn it on.',
    );
    expect(text).not.toContain('Commands:');
    expect(process.exitCode ?? 0).toBe(0);
    const json = JSON.parse(await lat('--json'));
    expect(json).toMatchObject({ enabled: false });
    expect(json.reason).toContain('lat usage enable');
    expect(fake.reads).toBe(0);
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#lat usage gaps says tracking is not enabled]]
  it('lat usage gaps says tracking is not enabled and creates nothing', async () => {
    const text = await lat('gaps');
    expect(text).toContain(
      'Usage tracking is not enabled; run `lat usage enable` to turn it on.',
    );
    expect(process.exitCode ?? 0).toBe(0);
    const json = JSON.parse(await lat('gaps', '--json'));
    expect(json).toMatchObject({ enabled: false, findings: [] });
    expect(fake.reads).toBe(0);
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#The lat_usage tool is absent when off]]
  it('the lat_usage MCP tool is not registered and creates nothing', () => {
    const tool = vi.fn();
    registerUsageTool({ tool } as never, () => root);
    expect(tool).not.toHaveBeenCalled();
    expect(existsSync(latDir(root))).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#The live endpoints serve empty data when off]]
  it('the live endpoints serve no data and create nothing', async () => {
    const clientDir = join(root, 'client');
    mkdirSync(clientDir);
    writeFileSync(join(clientDir, 'usage.html'), '<!doctype html><p>u</p>');
    configureUsageLive({
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 20,
      heartbeatMs: 20,
    });
    const server = await startViewServer(
      {
        projectRoot: root,
        latDir: join(root, 'lat.md'),
        mode: 'cli',
        styler: plainStyler,
      },
      { port: 0, watch: false, git: false, clientDir },
    );
    try {
      const get = async (path: string) =>
        (await fetch(server.url + path)).json();
      const summary = await get('api/usage');
      expect(summary.totals.tokens.messages).toBe(0);
      expect((await get('api/usage/raw')).records).toEqual([]);
      expect((await get('api/usage/findings')).findings).toEqual([]);
      expect(fake.reads).toBe(0);
      expect(existsSync(latDir(root))).toBe(false);
    } finally {
      stopUsageLive();
      configureUsageLive({});
      await server.close();
    }
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Disable stays effective]]
  it('no read path recreates the directory after disable', async () => {
    await lat('enable');
    await lat();
    await lat('disable');
    expect(existsSync(usageDir(root))).toBe(false);
    await lat();
    await lat('gaps');
    const aggregator = await createAggregator({
      root,
      bd: { refresh: async () => null },
    });
    await aggregator.summary();
    expect(existsSync(usageDir(root))).toBe(false);
    expect(await lat('enable')).not.toContain('Already enabled');
  });
});

describe('the usage directory is always ignored by git', () => {
  // @lat: [[usage-opt-in#Usage Opt-in#Enable writes an ignore file]]
  it('lat usage enable writes a .gitignore that ignores everything', async () => {
    await lat('enable');
    expect(readFileSync(join(usageDir(root), '.gitignore'), 'utf-8')).toBe(
      '*\n',
    );
    expect(
      git(root, 'status', '--porcelain', '--untracked-files=all', '--', '.lat'),
    ).toBe('');
  });

  it('lat usage enable adds the ignore file to a directory that lacks one', async () => {
    mkdirSync(usageDir(root), { recursive: true });
    expect(await lat('enable')).toContain('Already enabled');
    expect(readFileSync(join(usageDir(root), '.gitignore'), 'utf-8')).toBe(
      '*\n',
    );
  });

  // @lat: [[usage-opt-in#Usage Opt-in#A committed ignore file is replaced]]
  it('replaces an empty committed .gitignore with one that ignores everything', async () => {
    mkdirSync(usageDir(root), { recursive: true });
    writeFileSync(join(usageDir(root), '.gitignore'), '');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ship an empty ignore file');
    await lat('enable');
    expect(readFileSync(join(usageDir(root), '.gitignore'), 'utf-8')).toBe(
      '*\n',
    );
    saveState(root, emptyState());
    git(root, 'add', '-A', '--', '.lat');
    expect(git(root, 'diff', '--cached', '--name-only').split('\n')).toEqual([
      '.lat/usage/.gitignore',
    ]);
  });

  it('replaces a symlinked .gitignore without writing through it', () => {
    mkdirSync(usageDir(root), { recursive: true });
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'original\n');
    symlinkSync(outside, join(usageDir(root), '.gitignore'));
    saveState(root, emptyState());
    expect(readFileSync(outside, 'utf-8')).toBe('original\n');
    expect(lstatSync(join(usageDir(root), '.gitignore')).isFile()).toBe(true);
    expect(readFileSync(join(usageDir(root), '.gitignore'), 'utf-8')).toBe(
      '*\n',
    );
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Saving state adds a missing ignore file]]
  it('saving state into a directory without an ignore file adds one', () => {
    mkdirSync(usageDir(root), { recursive: true });
    saveState(root, emptyState());
    expect(existsSync(join(usageDir(root), 'state.json'))).toBe(true);
    expect(readFileSync(join(usageDir(root), '.gitignore'), 'utf-8')).toBe(
      '*\n',
    );
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '',
    );
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Saving state never follows a planted symlink]]
  it('saving state through a planted temporary-file symlink changes nothing outside', () => {
    mkdirSync(usageDir(root), { recursive: true });
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'original\n');
    symlinkSync(outside, join(usageDir(root), `state.json.${process.pid}.tmp`));
    expect(() => saveState(root, emptyState())).not.toThrow();
    expect(readFileSync(outside, 'utf-8')).toBe('original\n');
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Saving state survives a stale temporary file]]
  it('saving state replaces a stale temporary file of the same pid', () => {
    mkdirSync(usageDir(root), { recursive: true });
    const temporary = join(usageDir(root), `state.json.${process.pid}.tmp`);
    writeFileSync(temporary, 'left by a crash');
    saveState(root, emptyState());
    expect(
      JSON.parse(readFileSync(join(usageDir(root), 'state.json'), 'utf-8')),
    ).toEqual(emptyState());
    expect(existsSync(temporary)).toBe(false);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Saving state refuses a symlinked usage directory]]
  it('saving state through a symlinked .lat/usage writes nothing outside', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    mkdirSync(latDir(root));
    symlinkSync(outside, usageDir(root));
    expect(() => saveState(root, emptyState())).not.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('saving state with no directory writes nothing', () => {
    vi.stubEnv('LAT_USAGE', '1');
    saveState(root, emptyState());
    expect(existsSync(latDir(root))).toBe(false);
  });
});

describe('readers never follow a planted symlink', () => {
  const event = JSON.stringify({
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: 'e1',
    ts: '2026-11-08T10:00:00Z',
    duration_ms: 1,
    command: 'search',
    surface: 'cli',
    caller: 'agent',
    agent: null,
    lat_version: '0.0.0',
    session_id: null,
    parent_session_id: null,
    repo_root: '/repo',
    git_head: null,
    worktree: null,
    query: null,
    result_ids: [],
    result_count: null,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: 0,
    error_class: null,
    unknown_reasons: {},
  } satisfies UsageEvent);

  // @lat: [[usage-opt-in#Usage Opt-in#A symlinked .lat is not opted in]]
  it('a symlinked .lat or .lat/usage does not opt the project in', () => {
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'usage'), { recursive: true });
    symlinkSync(outside, latDir(root));
    expect(usageEnabled(root)).toBe(false);
    rmSync(latDir(root));
    mkdirSync(latDir(root));
    symlinkSync(join(outside, 'usage'), usageDir(root));
    expect(usageEnabled(root)).toBe(false);
    vi.stubEnv('LAT_USAGE', '1');
    expect(usageEnabled(root)).toBe(true);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Loading state reads only a regular file]]
  it('loading state does not read a symlinked or special state.json', () => {
    mkdirSync(usageDir(root), { recursive: true });
    const outside = join(root, 'outside.json');
    const foreign = { ...emptyState(), logs: { 'x.jsonl': 7 } };
    expect(foreign.version).toBe(USAGE_STATE_VERSION);
    writeFileSync(outside, JSON.stringify(foreign));
    symlinkSync(outside, join(usageDir(root), 'state.json'));
    expect(loadState(root)).toEqual(emptyState());
    rmSync(join(usageDir(root), 'state.json'));
    symlinkSync('/dev/zero', join(usageDir(root), 'state.json'));
    expect(loadState(root)).toEqual(emptyState());
  });

  // @lat: [[usage-opt-in#Usage Opt-in#Loading state drops malformed content]]
  it('loading state drops a malformed state.json and implausible stored events', async () => {
    mkdirSync(usageDir(root), { recursive: true });
    const path = join(usageDir(root), 'state.json');
    writeFileSync(path, JSON.stringify({ version: USAGE_STATE_VERSION }));
    expect(loadState(root)).toEqual(emptyState());
    const aggregator = await createAggregator({
      root,
      bd: { refresh: async () => null },
    });
    await expect(aggregator.refresh()).resolves.toBeUndefined();

    const good = JSON.parse(event) as UsageEvent;
    const future = { ...good, event_id: 'e2', ts: '3000-01-01T00:00:00Z' };
    const kept = { agent: 'claude', event: tokens('t1') };
    const stale = { agent: 'claude', event: { ...tokens('t2'), ts: 'never' } };
    writeFileSync(
      path,
      JSON.stringify({
        ...emptyState(),
        usage: { e1: good, e2: future },
        sessions: { t1: kept, t2: stale },
      }),
    );
    const state = loadState(root);
    expect(Object.keys(state.usage)).toEqual(['e1']);
    expect(Object.keys(state.sessions)).toEqual(['t1']);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#The event log reads only regular files]]
  it('a symlinked events file is not ingested', () => {
    mkdirSync(usageDir(root), { recursive: true });
    const outside = join(root, 'outside.jsonl');
    writeFileSync(outside, event + '\n');
    symlinkSync(outside, join(usageDir(root), 'events-2026-11.jsonl'));
    const state = emptyState();
    expect(readLog(root, state)).toBe(false);
    expect(state.usage).toEqual({});
    rmSync(join(usageDir(root), 'events-2026-11.jsonl'));
    writeFileSync(join(usageDir(root), 'events-2026-11.jsonl'), event + '\n');
    expect(readLog(root, state)).toBe(true);
    expect(Object.keys(state.usage)).toEqual(['e1']);
  });

  // @lat: [[usage-opt-in#Usage Opt-in#State keeps events whose ids look like object properties]]
  it('state keeps events whose ids are __proto__ and constructor through a save and load', () => {
    mkdirSync(usageDir(root), { recursive: true });
    const lines = ['__proto__', 'constructor'].map((id) =>
      JSON.stringify({ ...JSON.parse(event), event_id: id }),
    );
    writeFileSync(
      join(usageDir(root), 'events-2026-11.jsonl'),
      lines.join('\n') + '\n',
    );
    const state = emptyState();
    expect(readLog(root, state)).toBe(true);
    saveState(root, state);
    const loaded = loadState(root);
    for (const stored of [state, loaded])
      expect(Object.keys(stored.usage).sort()).toEqual([
        '__proto__',
        'constructor',
      ]);
    const next = { ...JSON.parse(event), event_id: 'toString' } as UsageEvent;
    expect(addUsageEvent(loaded, next)).toBe(true);
  });
});

describe('an unusable state.json is reported', () => {
  const stateFile = () => join(usageDir(root), 'state.json');
  const reports = () => errors.split('\n').filter((line) => line !== '');

  beforeEach(() => mkdirSync(usageDir(root), { recursive: true }));

  // @lat: [[usage-opt-in#Usage Opt-in#An unusable state.json is reported once]]
  it('prints one stderr message and loads an empty state', () => {
    writeFileSync(stateFile(), '{not json');
    expect(loadState(root)).toEqual(emptyState());
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toContain(statePath(root));
    expect(loadState(root)).toEqual(emptyState());
    expect(reports()).toHaveLength(1);
  });

  it.each([
    ['not valid JSON', '{not json'],
    ['a different version', JSON.stringify({ ...emptyState(), version: 1 })],
    ['a missing map', JSON.stringify({ version: USAGE_STATE_VERSION })],
    ['not an object', 'null'],
  ])('reports %s', (_name, text) => {
    writeFileSync(stateFile(), text);
    expect(loadState(root)).toEqual(emptyState());
    expect(reports()).toHaveLength(1);
  });

  it('reports an unreadable state.json', () => {
    writeFileSync(stateFile(), JSON.stringify(emptyState()));
    chmodSync(stateFile(), 0o000);
    try {
      expect(loadState(root)).toEqual(emptyState());
      expect(reports()).toHaveLength(1);
    } finally {
      chmodSync(stateFile(), 0o644);
    }
  });

  it('reports a symlinked state.json without reading it', () => {
    symlinkSync('/dev/zero', stateFile());
    expect(loadState(root)).toEqual(emptyState());
    expect(reports()).toHaveLength(1);
  });

  it('quotes nothing from the file', () => {
    writeFileSync(stateFile(), '\u001b[31mred');
    loadState(root);
    expect(errors).not.toContain('\u001b');
    expect(errors).not.toContain('red');
  });

  it('prints nothing for a missing state.json', () => {
    expect(loadState(root)).toEqual(emptyState());
    expect(errors).toBe('');
  });

  it('prints nothing for a usable state.json', () => {
    saveState(root, emptyState());
    expect(loadState(root)).toEqual(emptyState());
    expect(errors).toBe('');
  });

  it('prints nothing when there is no usage directory', () => {
    rmSync(usageDir(root), { recursive: true });
    expect(loadState(root)).toEqual(emptyState());
    expect(errors).toBe('');
  });
});
