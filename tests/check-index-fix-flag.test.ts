import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Regression test for lat-t1y.31: `check` and `check index` both declared a
// `--fix` option. Commander resolves `--fix` against the parent command in
// that arrangement, so the child action always saw `opts.fix === undefined`
// and `check index --fix` silently no-opped instead of writing the index.

const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

const fixtureDir = join(
  import.meta.dirname,
  'cases',
  'check-index-fix-subcommand',
);

function runInFreshCopy(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lat-check-index-fix-'));
  cpSync(fixtureDir, dir, { recursive: true });
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf-8',
    env: process.env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    dir,
  };
}

describe('check index --fix', () => {
  it('writes the directory index, not just reports errors', () => {
    const indexPath = join(fixtureDir, 'lat.md', 'guide', 'guide.md');
    expect(existsSync(indexPath)).toBe(false);

    const result = runInFreshCopy(['check', 'index', '--fix']);
    try {
      const writtenIndex = join(result.dir, 'lat.md', 'guide', 'guide.md');
      expect(result.stdout).toContain(
        'index: directory index files regenerated',
      );
      expect(existsSync(writtenIndex)).toBe(true);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });
});

describe('check --fix (regression guard)', () => {
  it('still writes the directory index unchanged', () => {
    const result = runInFreshCopy(['check', '--fix']);
    try {
      const writtenIndex = join(result.dir, 'lat.md', 'guide', 'guide.md');
      expect(existsSync(writtenIndex)).toBe(true);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });
});
