import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkIndex } from '../src/cli/check.js';

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

const casesDir = join(import.meta.dirname, 'cases');

const fixtureDir = join(casesDir, 'check-index-fix-subcommand');

function caseDir(name: string): string {
  return join(casesDir, name);
}

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

// --- check index --fix ---

async function withTmpCopy<T>(
  caseName: string,
  fn: (latDirPath: string) => Promise<T>,
): Promise<T> {
  const { mkdtemp, cp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const tmpRoot = await mkdtemp(join(tmpdir(), 'lat-index-fix-'));
  await cp(caseDir(caseName), tmpRoot, { recursive: true });
  try {
    return await fn(join(tmpRoot, 'lat.md'));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

// The acceptance criterion names `lat check --fix`, not `lat check index --fix`
// — an author who is told their index is stale by the top-level command has to
// be able to fix it with the command they just ran.
describe('lat check --fix', () => {
  // @lat: [[check-index#check --fix regenerates index files#lat check --fix repairs a failing tree end to end]]
  it('repairs a failing tree so that a plain lat check then passes', async () => {
    const { mkdtemp, cp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = await mkdtemp(join(tmpdir(), 'lat-check-fix-'));
    await cp(caseDir('index-fix-missing'), tmpRoot, { recursive: true });
    try {
      const run = (args: string[]) =>
        spawnSync(process.execPath, [cliPath, ...args], {
          cwd: tmpRoot,
          encoding: 'utf-8',
          env: process.env,
        });

      expect(run(['check']).status).toBe(1);
      expect(run(['check', '--fix']).status).toBe(0);
      expect(run(['check']).status).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('index-fix-missing', () => {
  // @lat: [[check-index#check --fix regenerates index files#Writes a missing index that then passes]]
  it('writes an index that then passes', async () => {
    await withTmpCopy('index-fix-missing', async (lat) => {
      const fixErrors = await checkIndex(lat, undefined, { fix: true });
      expect(fixErrors).toHaveLength(0);

      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(lat, 'lat.md'), 'utf-8');
      expect(content).toContain('](notes.md)');

      const errors = await checkIndex(lat);
      expect(errors).toHaveLength(0);
    });
  });
});

describe('index-fix-subdir', () => {
  // @lat: [[check-index#check --fix regenerates index files#Regenerates a subdirectory index before its parent]]
  it('regenerates a subdirectory index before its parent', async () => {
    await withTmpCopy('index-fix-subdir', async (lat) => {
      const fixErrors = await checkIndex(lat, undefined, { fix: true });
      expect(fixErrors).toHaveLength(0);

      const errors = await checkIndex(lat);
      expect(errors).toHaveLength(0);
    });
  });
});

describe('index-fix-title-injection', () => {
  // @lat: [[check-index#check --fix regenerates index files#Escapes a title shaped like a closing bracket]]
  it('produces one link, not two, for a title shaped like a closing bracket', async () => {
    await withTmpCopy('index-fix-title-injection', async (lat) => {
      await checkIndex(lat, undefined, { fix: true });

      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(lat, 'lat.md'), 'utf-8');
      const entryLine = content.split('\n').find((l) => l.startsWith('- ['))!;

      expect(entryLine).toBeDefined();
      // Exactly one Markdown link on the line: the hostile title's `]` and
      // `(` are backslash-escaped rather than closing/reopening the link.
      expect(entryLine.match(/\]\(/g)).toHaveLength(1);
      expect(entryLine).toContain('Real\\]');

      const errors = await checkIndex(lat);
      expect(errors).toHaveLength(0);
    });
  });
});

describe('index-fix-percent-filename', () => {
  // @lat: [[check-index#check --fix regenerates index files#Links to a file whose name contains a percent-encoded paren]]
  it('links to a file whose name already contains a percent-encoded paren', async () => {
    await withTmpCopy('index-fix-percent-filename', async (lat) => {
      await checkIndex(lat, undefined, { fix: true });

      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(lat, 'lat.md'), 'utf-8');
      const entryLine = content.split('\n').find((l) => l.startsWith('- ['))!;
      expect(entryLine).toBeDefined();

      const destMatch = entryLine.match(/\]\(([^)]*)\)/);
      expect(destMatch).not.toBeNull();
      const dest = destMatch![1];

      // The destination round-trips: percent-decoding it resolves to the
      // real file on disk.
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(lat, decodeURIComponent(dest)))).toBe(true);

      const errors = await checkIndex(lat);
      expect(errors).toHaveLength(0);
    });
  });
});
