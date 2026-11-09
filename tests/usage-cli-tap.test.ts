import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { rmDirBestEffort } from './util.js';
import { detectAgent } from '../src/fork/usage/agent-detect.js';
import { readGitState } from '../src/fork/usage/cli-tap.js';
import { registerForkCli } from '../src/fork/usage/cli-registration.js';
import {
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
} from '../src/fork/usage/schema.js';

const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx'),
).href;
const repoRoot = join(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'cases', 'basic-project');
const AGENT_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'PI_CODING_AGENT',
  'OPENCODE',
  'LAT_USAGE',
];

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(rmDirBestEffort));

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-usage-tap-'));
  roots.push(root);
  cpSync(fixture, root, { recursive: true });
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'init',
  );
  return root;
}

function runLat(
  root: string,
  args: string[],
  env: Record<string, string> = {},
  input = '',
) {
  const base = { ...process.env };
  for (const name of AGENT_VARIABLES) delete base[name];
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoader,
      join(repoRoot, 'src/cli/index.ts'),
      '--dir',
      root,
      ...args,
    ],
    { cwd: root, env: { ...base, ...env }, input, encoding: 'utf-8' },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function readEvents(root: string): UsageEvent[] {
  const dir = join(root, '.lat', 'usage');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf-8').split('\n').filter(Boolean),
    )
    .map((line) => JSON.parse(line));
}

// @lat: [[usage-tap#Usage Tap#Tracking off writes nothing]]
describe('CLI tap', () => {
  it('performs no file system write when tracking is off', () => {
    const root = makeProject();
    const result = runLat(root, ['section', 'nonexistent#x']);
    expect(result.status).toBe(1);
    expect(existsSync(join(root, '.lat'))).toBe(false);
  });

  // @lat: [[usage-tap#Usage Tap#One event per command]]
  it('appends exactly one valid event per command when tracking is on', () => {
    const root = makeProject();
    const env = { LAT_USAGE: '1' };
    runLat(root, ['search', 'testing'], env);
    runLat(root, ['section', 'nonexistent#x'], env);
    runLat(root, ['expand', 'see [[nonexistent#x]]'], env);
    runLat(root, ['refs', 'nonexistent#x'], env);
    runLat(root, ['hook', 'claude', 'Stop'], env, '{}');
    const events = readEvents(root);
    expect(events.map((e) => e.command)).toEqual([
      'search',
      'section',
      'expand',
      'refs',
      'hook',
    ]);
    for (const event of events) {
      expect(event.schema_version).toBe(USAGE_SCHEMA_VERSION);
      expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
      expect(event.repo_root).toBe(root);
      expect(typeof event.exit_code).toBe('number');
    }
    const hook = events.find((e) => e.command === 'hook')!;
    expect(hook.surface).toBe('hook');
    expect(hook.caller).toBe('hook-injected');
    expect(events.find((e) => e.command === 'expand')!.query).toBe(
      'see [[nonexistent#x]]',
    );
  });

  // @lat: [[usage-tap#Usage Tap#A failed command still records]]
  it('records a section lookup with no match with exit code 1', () => {
    const root = makeProject();
    const result = runLat(root, ['section', 'nonexistent#x'], {
      LAT_USAGE: '1',
    });
    expect(result.status).toBe(1);
    const [event] = readEvents(root);
    expect(event.command).toBe('section');
    expect(event.exit_code).toBe(1);
    expect(event.error_class).toBe('nonzero_exit');
  });

  // @lat: [[usage-tap#Usage Tap#Search events carry context]]
  it('fills query, git head, worktree, duration and version on a search event', () => {
    const root = makeProject();
    runLat(root, ['search', 'testing'], { LAT_USAGE: '1' });
    const [event] = readEvents(root);
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
    expect(event.query).toBe('testing');
    expect(event.git_head).toBe(head);
    expect(event.worktree).not.toBeNull();
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
    expect(event.lat_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(event.caller).toBe('human');
    expect(event.agent).toBeNull();
    expect(event.session_id).toBeNull();
    expect(event.exit_code).toBe(0);
    expect(event.error_class).toBeNull();
  });

  // @lat: [[usage-tap#Usage Tap#Agent detection]]
  it('tags the calling agent and session from its environment', () => {
    const root = makeProject();
    runLat(root, ['section', 'nonexistent#x'], {
      LAT_USAGE: '1',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'session-42',
    });
    const [event] = readEvents(root);
    expect(event.caller).toBe('agent');
    expect(event.agent).toBe('claude');
    expect(event.session_id).toBe('session-42');
  });

  // @lat: [[usage-tap#Usage Tap#A read-only usage directory changes nothing]]
  it('leaves output and exit code unchanged when .lat/usage is read-only', () => {
    const untracked = makeProject();
    const expected = runLat(untracked, ['section', 'nonexistent#x']);

    const root = makeProject();
    const dir = join(root, '.lat', 'usage');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      const actual = runLat(root, ['section', 'nonexistent#x']);
      expect(actual).toEqual(expected);
      expect(readEvents(root)).toEqual([]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // @lat: [[usage-tap#Usage Tap#Usage enable and disable are not tapped]]
  it('leaves tracking off after usage disable through the real CLI', () => {
    const root = makeProject();
    runLat(root, ['usage', 'enable']);
    runLat(root, ['search', 'testing']);
    expect(readEvents(root).map((e) => e.command)).toEqual(['search']);

    const result = runLat(root, ['usage', 'disable']);
    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.lat', 'usage'))).toBe(false);
    expect(existsSync(join(root, '.lat', 'usage.disabled'))).toBe(true);

    runLat(root, ['search', 'testing']);
    expect(existsSync(join(root, '.lat', 'usage'))).toBe(false);
  });

  // @lat: [[usage-tap#Usage Tap#Registration]]
  it('registerForkCli installs a hook that records the command on exit', async () => {
    const root = makeProject();
    const exitListeners: Array<(code: number) => void> = [];
    const once = vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: (code: number) => void,
    ) => {
      if (event === 'exit') exitListeners.push(listener);
      return process;
    }) as never);
    vi.stubEnv('LAT_USAGE', '1');
    try {
      const program = new Command()
        .name('lat')
        .version('9.9.9')
        .option('--dir <path>');
      registerForkCli(program);
      program
        .command('probe')
        .argument('[q]')
        .action(() => {});
      await program.parseAsync(['--dir', root, 'probe', 'hello'], {
        from: 'user',
      });
      expect(exitListeners).toHaveLength(1);
      exitListeners[0](0);
    } finally {
      once.mockRestore();
      vi.unstubAllEnvs();
    }
    const [event] = readEvents(root);
    expect(event.command).toBe('probe');
    expect(event.lat_version).toBe('9.9.9');
  });
});

// @lat: [[usage-tap#Usage Tap#Agent detection]]
describe('detectAgent', () => {
  it('reports null with reason unsupported_by_agent when no agent variable is set', () => {
    const detected = detectAgent({});
    expect(detected.agent).toEqual({
      value: null,
      reason: 'unsupported_by_agent',
    });
    expect(detected.sessionId).toEqual({
      value: null,
      reason: 'unsupported_by_agent',
    });
  });

  it('reads the agent and session id each agent sets', () => {
    expect(
      detectAgent({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }),
    ).toEqual({ agent: { value: 'claude' }, sessionId: { value: 's1' } });
    expect(detectAgent({ CODEX_THREAD_ID: 't1' })).toEqual({
      agent: { value: 'codex' },
      sessionId: { value: 't1' },
    });
    expect(detectAgent({ ANTIGRAVITY_CONVERSATION_ID: 'c1' })).toEqual({
      agent: { value: 'antigravity' },
      sessionId: { value: 'c1' },
    });
  });

  it('names pi and OpenCode but records no session id for them', () => {
    const unknown = { value: null, reason: 'unsupported_by_agent' };
    expect(detectAgent({ PI_CODING_AGENT: 'true' })).toEqual({
      agent: { value: 'pi' },
      sessionId: unknown,
    });
    expect(detectAgent({ OPENCODE: '1' })).toEqual({
      agent: { value: 'opencode' },
      sessionId: unknown,
    });
  });
});

// @lat: [[usage-tap#Usage Tap#Unknown fields carry a reason]]
describe('unknown fields', () => {
  it('writes null with a reason for every field the tap cannot know', () => {
    const root = makeProject();
    runLat(root, ['refs', 'nonexistent#x'], { LAT_USAGE: '1' });
    const [event] = readEvents(root);
    expect(event.result_count).toBeNull();
    expect(event.unknown_reasons).toMatchObject({
      result_count: 'not_captured',
      found: 'not_captured',
      section_id: 'not_captured',
      agent: 'unsupported_by_agent',
      session_id: 'unsupported_by_agent',
    });
    expect(event.unknown_reasons.git_head).toBeUndefined();
    expect(event.unknown_reasons.query).toBeUndefined();
  });
});

// @lat: [[usage-tap#Usage Tap#No project root means no tap]]
describe('without a project root', () => {
  it('creates nothing when LAT_USAGE=1 and no lat.md directory exists', () => {
    const bare = mkdtempSync(join(tmpdir(), 'lat-usage-bare-'));
    roots.push(bare);
    runLat(bare, ['check'], { LAT_USAGE: '1' });
    expect(existsSync(join(bare, '.lat'))).toBe(false);
  });
});

// @lat: [[usage-tap#Usage Tap#The tap never throws]]
describe('tap failures', () => {
  it('does not fail the command when the project root lookup throws', async () => {
    const program = new Command()
      .name('lat')
      .option('--dir <path>', 'dir', () => 42 as unknown as string);
    registerForkCli(program);
    let ran = false;
    program.command('probe').action(() => {
      ran = true;
    });
    await program.parseAsync(['--dir', 'x', 'probe'], { from: 'user' });
    expect(ran).toBe(true);
  });

  it('does not throw from the exit listener', async () => {
    const root = makeProject();
    const listeners: Array<(code: number) => void> = [];
    const once = vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: (code: number) => void,
    ) => {
      if (event === 'exit') listeners.push(listener);
      return process;
    }) as never);
    vi.stubEnv('LAT_USAGE', '1');
    try {
      const program = new Command().name('lat').option('--dir <path>');
      registerForkCli(program);
      program.version = (() => {
        throw new Error('no version');
      }) as never;
      program.command('probe').action(() => {});
      await program.parseAsync(['--dir', root, 'probe'], { from: 'user' });
      expect(listeners).toHaveLength(1);
      expect(() => listeners[0](0)).not.toThrow();
    } finally {
      once.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

// @lat: [[usage-tap#Usage Tap#Git state is read from files]]
describe('readGitState', () => {
  const sha = 'a'.repeat(40);

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lat-usage-git-'));
    roots.push(dir);
    return dir;
  }

  it('resolves a loose branch ref', () => {
    const dir = makeDir();
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), sha + '\n');
    expect(readGitState(dir)).toEqual({ head: sha, worktree: dir });
  });

  it('resolves a packed ref', () => {
    const dir = makeDir();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(dir, '.git', 'packed-refs'),
      `# pack-refs\n${sha} refs/heads/main\n${'b'.repeat(40)} refs/heads/other\n`,
    );
    expect(readGitState(dir).head).toBe(sha);
  });

  it('reads a detached head', () => {
    const dir = makeDir();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), sha + '\n');
    expect(readGitState(dir).head).toBe(sha);
  });

  it('follows a worktree .git file to its git dir and common dir', () => {
    const dir = makeDir();
    const main = join(dir, 'main');
    const worktree = join(dir, 'wt');
    const gitDir = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(join(main, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree);
    writeFileSync(join(main, '.git', 'refs', 'heads', 'feature'), sha + '\n');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    expect(readGitState(worktree)).toEqual({ head: sha, worktree });
  });

  it('returns nulls outside a repository without throwing', () => {
    const dir = makeDir();
    expect(readGitState(dir)).toEqual({ head: null, worktree: null });
  });
});
