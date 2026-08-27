import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmDirBestEffort } from './util.js';

const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

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

describe('hook stop', () => {
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
});
