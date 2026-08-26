import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { rmDirBestEffort } from './util.js';
import { syncLatHooks } from '../src/cli/init.js';

// Spy on loadAllSections while keeping its real implementation, so the tests
// below can count how many times the tree is actually walked and parsed —
// the seam lat-t1y.23 threads a pre-loaded-sections parameter through.
vi.mock('../src/lattice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lattice.js')>();
  return { ...actual, loadAllSections: vi.fn(actual.loadAllSections) };
});

vi.mock('../src/search/db.js', () => ({
  openDb: vi.fn(() => ({})),
  ensureMeta: vi.fn(async () => {}),
  getStoredModel: vi.fn(async () => 'fake-model'),
  ensureSectionsSchema: vi.fn(async () => {}),
  closeDb: vi.fn(async () => {}),
}));

vi.mock('../src/search/embedder.js', () => ({
  embedderForIndex: vi.fn(async () => ({ dimensions: 3, name: 'local:fake' })),
}));

vi.mock('../src/search/search.js', () => ({
  searchSections: vi.fn(async () => [
    { id: 'feature', file: '', heading: '', content: '' },
  ]),
}));

const casesDir = join(import.meta.dirname, 'cases');
const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

/** Build a numstat string from [added, removed, file] tuples. */
function numstat(files: [number, number, string][]): string {
  return files.map(([a, r, f]) => `${a}\t${r}\t${f}`).join('\n');
}

/**
 * Create a temp dir with a fake `git` that prints the given numstat regardless
 * of args. Cross-platform: the payload is stored in a data file (preserving the
 * tab separators), and both a POSIX `git` shell script and a Windows `git.cmd`
 * batch shim emit it — so the hook's `git diff --numstat` is intercepted on
 * every OS. Callers prepend this dir to PATH.
 */
function makeFakeGitDir(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-hook-'));
  const dataFile = join(dir, 'numstat.txt');
  writeFileSync(dataFile, output);

  // POSIX: `git` shell script.
  const shScript = join(dir, 'git');
  writeFileSync(shScript, '#!/bin/sh\ncat "$(dirname "$0")/numstat.txt"\n');
  chmodSync(shScript, 0o755);

  // Windows: `git.cmd` batch shim (resolved via PATHEXT). `type` preserves tabs.
  const cmdScript = join(dir, 'git.cmd');
  writeFileSync(cmdScript, '@type "%~dp0numstat.txt"\r\n');

  return dir;
}

/** Run `lat hook <agent> <event>` against a test case dir. */
function runHook(
  agent: string,
  event: string,
  caseDir: string,
  opts: {
    stopHookActive?: boolean;
    fakeBinDir?: string;
    prompt?: string;
  } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const stdinJson = JSON.stringify({
    stop_hook_active: opts.stopHookActive ?? false,
    ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
  });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (opts.fakeBinDir) {
    // Prepend using the OS path delimiter (';' on Windows). Windows env vars are
    // case-insensitive, so drop any existing `Path` key before setting `PATH` to
    // avoid the child inheriting the unmodified value under a different casing.
    const orig = env.PATH ?? env.Path ?? '';
    delete env.Path;
    delete env.PATH;
    env.PATH = opts.fakeBinDir + delimiter + orig;
  }

  const result = spawnSync('node', [cliPath, 'hook', agent, event], {
    cwd: caseDir,
    encoding: 'utf-8',
    input: stdinJson,
    env,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function runStopHook(
  agent: 'claude' | 'codex' | 'cursor',
  caseDir: string,
  opts: {
    stopHookActive?: boolean;
    fakeBinDir?: string;
  } = {},
): { stdout: string; stderr: string; exitCode: number } {
  return runHook(agent, agent === 'cursor' ? 'stop' : 'Stop', caseDir, opts);
}

const clean = join(casesDir, 'hook-clean');
const broken = join(casesDir, 'error-broken-links');

describe('hook stop', () => {
  // @lat: [[tests/hook#Exits silently when check passes and no diff]]
  it('exits silently when check passes and no diff', () => {
    const fakeBinDir = makeFakeGitDir('');
    try {
      const { stdout, stderr } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Blocks when lat check fails]]
  it('blocks when lat check fails', () => {
    const { stdout } = runStopHook('claude', broken);
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('lat check');
    expect(parsed.reason).toContain('error');
  });

  // @lat: [[hook#Blocks on a Diátaxis mode error at stop time]]
  it('blocks when the only failure is a Diátaxis mode error', () => {
    // `checkAllCommand` counts mode errors in its total; `getStopStatus` must
    // too. When the two drift apart, `lat check` fails on the command line
    // while the Stop hook calls the same tree clean and lets the session end
    // with the post-task checklist reported as complete.
    const dir = mkdtempSync(join(tmpdir(), 'lat-mode-stop-'));
    const latMd = join(dir, 'lat.md');
    mkdirSync(latMd, { recursive: true });
    writeFileSync(
      join(latMd, 'lat.md'),
      '# Mode Stop\n\nA tree whose only defect is an imperative in an explanation.\n\n- [[topic]] — the offending document\n',
    );
    writeFileSync(
      join(latMd, 'topic.md'),
      '---\nlat:\n  mode: explanation\n---\n\n# Topic\n\nDescribes the topic without commanding the reader.\n\nRun the server to see it work.\n',
    );

    const fakeBinDir = makeFakeGitDir('');
    try {
      const { stdout } = runStopHook('claude', dir, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('lat check');
    } finally {
      rmDirBestEffort(fakeBinDir);
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Blocks when code diff is large but lat.md/ not updated]]
  it('blocks when code diff is large but lat.md/ not updated', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('110');
      expect(parsed.reason).toContain('lat.md/');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Exits silently when lat.md/ changes are proportional]]
  it('exits silently when lat.md/ changes are proportional', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([
        [60, 40, 'src/feature.ts'],
        [8, 2, 'lat.md/feature.md'],
      ]),
    );
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Exits silently when code diff is below threshold]]
  it('exits silently when code diff is below threshold', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[2, 1, 'src/tiny.ts']]));
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Blocks with both messages when check fails and diff needs sync]]
  it('blocks with both messages when check fails and diff needs sync', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[50, 60, 'src/refactor.ts']]));
    try {
      const { stdout } = runStopHook('claude', broken, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('Update `lat.md/`');
      expect(parsed.reason).toContain('lat check` until it passes');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Exits silently on second pass when check passes]]
  it('exits silently on second pass when check passes', () => {
    const { stdout, stderr } = runStopHook('claude', clean, {
      stopHookActive: true,
    });
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  // @lat: [[tests/hook#Prints stderr warning on second pass when check still fails]]
  it('prints stderr warning on second pass when check still fails', () => {
    const { stdout, stderr } = runStopHook('claude', broken, {
      stopHookActive: true,
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('still failing');
  });

  // @lat: [[tests/hook#Ignores non-code files in diff]]
  it('ignores non-code files in diff', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[150, 50, 'README.md']]));
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Cursor stop hook returns follow-up work instead of a Claude block]]
  it('returns a Cursor follow-up message when stop needs more work', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const { stdout } = runStopHook('cursor', clean, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.followup_message).toContain('lat.md/');
      expect(parsed.followup_message).toContain('110');
      expect(parsed.decision).toBeUndefined();
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Codex stop hook returns a block decision]]
  it('returns a Codex block decision when stop needs more work', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const { stdout } = runStopHook('codex', clean, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('lat.md/');
      expect(parsed.reason).toContain('110');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('Codex hook integration', () => {
  // @lat: [[tests/hook#Codex prompt hook reads the Codex prompt field]]
  it('reads the Codex prompt field and expands wiki links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-codex-prompt-'));
    const projectDir = join(dir, 'project');
    cpSync(clean, projectDir, { recursive: true });
    try {
      const { stdout } = runHook('codex', 'UserPromptSubmit', projectDir, {
        prompt: 'Update [[feature]]',
      });
      const parsed = JSON.parse(stdout);
      const context = parsed.hookSpecificOutput.additionalContext;
      expect(context).toContain('Expanded user prompt');
      expect(context).toContain('[[lat.md/feature#Feature]]');
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Codex hook setup preserves non-lat hooks]]
  it('syncs Codex hooks while preserving non-lat hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-codex-hooks-'));
    const hooksPath = join(dir, 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify({
        description: 'Workspace hooks',
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: 'command', command: 'custom prompt hook' }],
            },
            {
              hooks: [
                {
                  type: 'command',
                  command: 'lat hook claude UserPromptSubmit',
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: 'command', command: 'lat hook codex Stop' }],
            },
          ],
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'custom tool hook' }],
            },
          ],
        },
      }),
    );

    try {
      syncLatHooks(hooksPath, 'global', 'codex');
      const config = JSON.parse(readFileSync(hooksPath, 'utf-8'));
      expect(config.description).toBe('Workspace hooks');
      expect(config.hooks.PreToolUse).toHaveLength(1);
      expect(config.hooks.UserPromptSubmit).toHaveLength(2);
      expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
        'custom prompt hook',
      );
      expect(config.hooks.UserPromptSubmit[1].hooks[0].command).toBe(
        'lat hook codex UserPromptSubmit',
      );
      expect(config.hooks.Stop).toHaveLength(1);
      expect(config.hooks.Stop[0].hooks[0].command).toBe('lat hook codex Stop');
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Local JavaScript hook commands retain Node]]
  it('runs a local JavaScript CLI through Node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-codex-local-hooks-'));
    const hooksPath = join(dir, 'hooks.json');
    const cliPath = join(dir, 'index.js');
    const originalScript = process.argv[1];

    try {
      writeFileSync(
        cliPath,
        'process.stdout.write(process.argv.slice(2).join(" "));\n',
      );
      process.argv[1] = cliPath;
      syncLatHooks(hooksPath, 'local', 'codex');

      const config = JSON.parse(readFileSync(hooksPath, 'utf-8'));
      const quote = (arg: string) => (arg.includes(' ') ? `"${arg}"` : arg);
      const command = config.hooks.Stop[0].hooks[0].command;
      expect(command).toBe(
        `${quote(process.execPath)} ${quote(cliPath)} hook codex Stop`,
      );

      const result = spawnSync(command, { shell: true, encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('hook codex Stop');
    } finally {
      process.argv[1] = originalScript;
      rmDirBestEffort(dir);
    }
  });
});

describe('parses the lat.md tree once per prompt (lat-t1y.23)', () => {
  // @lat: [[hook#Parses the lat.md tree once per prompt (lat-t1y.23)#expandPrompt uses preloaded sections instead of re-parsing the tree]]
  it('expandPrompt uses preloaded sections instead of re-parsing the tree', async () => {
    const { loadAllSections } = await import('../src/lattice.js');
    const { expandPrompt } = await import('../src/cli/expand.js');
    const spy = vi.mocked(loadAllSections);
    spy.mockClear();

    const latDir = join(clean, 'lat.md');
    const ctx = {
      latDir,
      projectRoot: clean,
      styler: {
        bold: (s: string) => s,
        dim: (s: string) => s,
        red: (s: string) => s,
        cyan: (s: string) => s,
        white: (s: string) => s,
        green: (s: string) => s,
        yellow: (s: string) => s,
        boldWhite: (s: string) => s,
      },
      mode: 'cli' as const,
    };

    // Baseline: no preloaded sections still works, and still walks the tree.
    const withoutPreload = await expandPrompt(ctx, '[[feature]]');
    expect(withoutPreload).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    // With preloaded sections, the tree is not walked again.
    spy.mockClear();
    const preloaded = await spy.getMockImplementation()!(latDir);
    const withPreload = await expandPrompt(ctx, '[[feature]]', preloaded);
    expect(spy).not.toHaveBeenCalled();

    // Results are byte-identical whether or not sections were preloaded.
    expect(withPreload).toBe(withoutPreload);
  });

  // @lat: [[hook#Parses the lat.md tree once per prompt (lat-t1y.23)#runSearch resolves matches from preloaded sections without re-parsing the tree]]
  it('runSearch resolves matches from preloaded sections without re-parsing the tree', async () => {
    const { loadAllSections, flattenSections } =
      await import('../src/lattice.js');
    const { runSearch } = await import('../src/cli/search.js');
    const spy = vi.mocked(loadAllSections);

    const latDir = join(clean, 'lat.md');
    const preloaded = await spy.getMockImplementation()!(latDir);
    const featureId = flattenSections(preloaded).find((s) =>
      s.filePath.endsWith('feature.md'),
    )!.id;
    vi.mocked(
      (await import('../src/search/search.js')).searchSections,
    ).mockResolvedValue([
      { id: featureId, file: '', heading: '', content: '' },
    ]);

    spy.mockClear();
    const withPreload = await runSearch(latDir, 'feature', 5, undefined, {
      buildIndex: false,
      preloadedSections: preloaded,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(withPreload.matches).toHaveLength(1);
    expect(withPreload.matches[0].section.id).toBe(featureId);

    // Passing no preloaded sections is unchanged: it still resolves the
    // match by walking the tree itself.
    spy.mockClear();
    const withoutPreload = await runSearch(latDir, 'feature', 5, undefined, {
      buildIndex: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(withoutPreload.matches).toEqual(withPreload.matches);
  });
});
