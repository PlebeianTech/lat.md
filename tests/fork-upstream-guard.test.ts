import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ALLOWLIST_FILE,
  FORK_POINT,
  classify,
  hasCommit,
  parseAllowlist,
  parseNameStatus,
  renderAllowlist,
  repoRoot,
  runGuard,
  type GuardResult,
} from '../src/fork/upstream-guard.js';

let repo: string;
let forkPoint: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'guard',
  GIT_AUTHOR_EMAIL: 'guard@example.invalid',
  GIT_COMMITTER_NAME: 'guard',
  GIT_COMMITTER_EMAIL: 'guard@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function allowlist(...entries: [string, string][]): void {
  write(
    ALLOWLIST_FILE,
    renderAllowlist(
      entries.map(([path, reason]) => ({ path, reason, line: 0 })),
    ),
  );
}

function guard(): GuardResult {
  return runGuard({
    repo,
    forkPoint,
    allowlistFile: ALLOWLIST_FILE,
    regenerate: false,
    fetch: false,
  });
}

function regenerate(): GuardResult {
  return runGuard({
    repo,
    forkPoint,
    allowlistFile: ALLOWLIST_FILE,
    regenerate: true,
    fetch: false,
  });
}

function reset(): void {
  git('reset', '-q', '--hard');
  git('clean', '-fdq');
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lat-upstream-guard-'));
  git('init', '-q', '-b', 'main');
  write('upstream-a.txt', 'a\n');
  write('upstream-b.txt', 'b\n');
  write('nested/upstream-c.txt', 'c\n');
  git('add', '-A');
  git('commit', '-qm', 'upstream');
  forkPoint = git('rev-parse', 'HEAD').trim();
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('upstream guard', () => {
  it('rejects an edit to an upstream file that is not allowlisted', () => {
    write('upstream-a.txt', 'a edited\n');
    allowlist(['upstream-b.txt', 'a different file entirely']);
    const result = guard();
    reset();

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(['unallowlisted']);
    expect(result.report).toContain('upstream-a.txt');
    expect(result.report).toContain('not allowlisted');
  });

  it('accepts an edit to an upstream file that is allowlisted', () => {
    write('upstream-a.txt', 'a edited\n');
    allowlist(['upstream-a.txt', 'the reason this file must diverge']);
    const result = guard();
    reset();

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a deletion of an upstream file even when it is allowlisted', () => {
    rmSync(join(repo, 'nested/upstream-c.txt'));
    allowlist([
      'nested/upstream-c.txt',
      'allowlisted, and still not deletable',
    ]);
    const result = guard();
    reset();

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(['deletion']);
    expect(result.report).toContain('deletes an upstream file');
    expect(result.report).toContain('every future merge');
  });

  it('accepts a brand-new fork-owned file', () => {
    write('src/fork/new-thing.ts', 'export const x = 1;\n');
    git('add', '-A');
    allowlist();
    const staged = guard();
    reset();

    expect(staged.findings).toEqual([]);
    expect(staged.ok).toBe(true);
  });

  it('rejects an allowlist entry whose reason is still a placeholder', () => {
    write('upstream-b.txt', 'b edited\n');
    allowlist(['upstream-b.txt', 'TODO: why must this upstream file diverge?']);
    const result = guard();
    reset();

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(['missing-reason']);
  });

  it('warns about an allowlist entry no file needs any more', () => {
    allowlist(['upstream-a.txt', 'nothing touches this file now']);
    const result = guard();
    reset();

    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toContain('no longer modified');
  });

  it('names the fetch command when the fork point is missing', () => {
    const result = runGuard({
      repo,
      forkPoint: '0'.repeat(40),
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: false,
    });

    expect(result.ok).toBe(false);
    expect(result.report).toContain('git fetch --no-tags --depth=1 origin');
  });

  it('regenerating keeps existing reasons and marks new entries', () => {
    write('upstream-a.txt', 'a edited\n');
    write('upstream-b.txt', 'b edited\n');
    allowlist(['upstream-a.txt', 'a reason worth keeping']);
    const result = regenerate();
    const written = parseAllowlist(
      readFileSync(join(repo, ALLOWLIST_FILE), 'utf-8'),
    );
    reset();

    const byPath = new Map(written.entries.map((e) => [e.path, e.reason]));
    expect(byPath.get('upstream-a.txt')).toBe('a reason worth keeping');
    expect(byPath.get('upstream-b.txt')).toMatch(/^TODO/);
    expect(result.report).toContain('new entry needs a reason: upstream-b.txt');
  });

  it('regenerating refuses to allowlist a deletion', () => {
    rmSync(join(repo, 'upstream-b.txt'));
    allowlist();
    const result = regenerate();
    const written = parseAllowlist(
      readFileSync(join(repo, ALLOWLIST_FILE), 'utf-8'),
    );
    reset();

    expect(result.ok).toBe(false);
    expect(written.entries.map((e) => e.path)).not.toContain('upstream-b.txt');
    expect(result.report).toContain('never allowlistable');
  });

  it('reports a malformed allowlist line rather than ignoring it', () => {
    write(ALLOWLIST_FILE, 'upstream-a.txt\n');
    write('upstream-a.txt', 'a edited\n');
    const result = guard();
    reset();

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain('allowlist-error');
    expect(result.report).toContain('has no reason');
  });

  it('parses name-status records and classifies without git', () => {
    const diff = parseNameStatus('M\0a.txt\0D\0b.txt\0A\0c.txt\0');
    expect(diff).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'D', path: 'b.txt' },
      { status: 'A', path: 'c.txt' },
    ]);

    const result = classify({
      diff,
      upstream: new Set(['a.txt', 'b.txt']),
      allowlist: new Map([
        ['a.txt', 'fine'],
        ['b.txt', 'still not deletable'],
      ]),
    });
    expect(result.findings.map((f) => f.kind)).toEqual(['deletion']);
    expect(result.touched).toEqual(['a.txt', 'b.txt']);
  });

  it('passes on this repository against the committed allowlist', () => {
    const root = repoRoot(process.cwd());
    expect(hasCommit(root, FORK_POINT)).toBe(true);

    const result = runGuard({
      repo: root,
      forkPoint: FORK_POINT,
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: false,
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
