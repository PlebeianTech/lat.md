import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import type { SessionEvent } from '../src/fork/usage/schema.js';
import { saveState, emptyState } from '../src/fork/usage/state.js';
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

beforeEach(() => {
  vi.stubEnv('LAT_USAGE', '');
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
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '',
    );
  });

  it('lat usage enable adds the ignore file to a directory that lacks one', async () => {
    mkdirSync(usageDir(root), { recursive: true });
    expect(await lat('enable')).toContain('Already enabled');
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

  it('saving state with no directory writes nothing', () => {
    vi.stubEnv('LAT_USAGE', '1');
    saveState(root, emptyState());
    expect(existsSync(latDir(root))).toBe(false);
  });
});
