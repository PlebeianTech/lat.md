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
  SYNC_POINT_FILE,
  classify,
  hasCommit,
  parseAllowlist,
  parseNameStatus,
  parseSyncPoint,
  renderSyncPoint,
  renderAllowlist,
  repoRoot,
  runGuard,
  type GuardResult,
} from '../src/fork/upstream-guard.js';

let repo: string;
let syncPoint: string;

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
    syncPoint,
    allowlistFile: ALLOWLIST_FILE,
    regenerate: false,
    fetch: false,
  });
}

function regenerate(): GuardResult {
  return runGuard({
    repo,
    syncPoint,
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
  syncPoint = git('rev-parse', 'HEAD').trim();
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
      syncPoint: '0'.repeat(40),
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
    const recorded = parseSyncPoint(
      readFileSync(join(root, SYNC_POINT_FILE), 'utf-8'),
    );
    expect(recorded).toMatch(/^[0-9a-f]{40}$/);

    // No syncPoint here on purpose: this is the path CI takes, reading the
    // recorded file rather than being handed a revision.
    //
    // fetch: true because a workflow that clones at the default depth of 1
    // does not carry the sync point, and this test must not depend on some
    // other step in some other workflow having fetched it first — publish.yml
    // has no such step. fetchSyncPoint only runs when the commit is absent,
    // so a normal checkout touches the network not at all.
    const result = runGuard({
      repo: root,
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: true,
    });

    expect(result.report).not.toContain('is not in this repository');
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(hasCommit(root, recorded!)).toBe(true);
  });
});

// @lat: [[upstream-guard#The upstream guard#The sync point]]
describe('the sync point', () => {
  it('stops reporting upstream churn once it is advanced past it', () => {
    // Stand in for an upstream commit landing on top of the recorded point.
    write('upstream-a.txt', 'a as upstream now has it\n');
    git('add', '-A');
    git('commit', '-qm', 'upstream moves on');
    const merged = git('rev-parse', 'HEAD').trim();

    allowlist(['upstream-b.txt', 'a different file entirely']);

    const stale = runGuard({
      repo,
      syncPoint,
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: false,
    });
    expect(stale.findings.map((f) => f.path)).toEqual(['upstream-a.txt']);

    const advanced = runGuard({
      repo,
      syncPoint: merged,
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: false,
    });
    expect(advanced.findings).toEqual([]);
    expect(advanced.ok).toBe(true);

    git('reset', '-q', '--hard', syncPoint);
    reset();
  });

  it('treats a file upstream added after the fork point as upstream-owned', () => {
    write('upstream-d.txt', 'd\n');
    git('add', '-A');
    git('commit', '-qm', 'upstream adds a file');
    const merged = git('rev-parse', 'HEAD').trim();

    write('upstream-d.txt', 'd, edited by the fork\n');
    allowlist(['upstream-b.txt', 'a different file entirely']);

    const result = runGuard({
      repo,
      syncPoint: merged,
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: false,
    });
    expect(result.findings.map((f) => f.kind)).toEqual(['unallowlisted']);
    expect(result.findings[0]!.path).toBe('upstream-d.txt');

    git('reset', '-q', '--hard', syncPoint);
    reset();
  });

  it('refuses a sync point that is not an ancestor of HEAD', () => {
    const orphan = spawnSync(
      'git',
      ['-C', repo, 'commit-tree', `${syncPoint}^{tree}`, '-m', 'elsewhere'],
      { encoding: 'utf-8', env: GIT_ENV },
    ).stdout.trim();

    const result = runGuard({
      repo,
      syncPoint: orphan,
      allowlistFile: ALLOWLIST_FILE,
      regenerate: false,
      fetch: false,
    });
    expect(result.ok).toBe(false);
    expect(result.report).toContain('not an ancestor of HEAD');
  });

  it('reports a missing record rather than guessing a baseline', () => {
    const result = runGuard({
      repo,
      allowlistFile: ALLOWLIST_FILE,
      syncPointFile: 'no-such-sync-point',
      regenerate: false,
      fetch: false,
    });
    expect(result.ok).toBe(false);
    expect(result.report).toContain('no sync point recorded');
  });

  it('records a revision and keeps the surrounding prose', () => {
    write(SYNC_POINT_FILE, '# why this file exists\n\ndeadbeef\n');
    const result = runGuard({
      repo,
      allowlistFile: ALLOWLIST_FILE,
      setSyncPoint: syncPoint,
      regenerate: false,
      fetch: false,
    });
    expect(result.ok).toBe(true);

    const written = readFileSync(join(repo, SYNC_POINT_FILE), 'utf-8');
    expect(written).toContain('# why this file exists');
    expect(parseSyncPoint(written)).toBe(syncPoint);
    reset();
  });

  it('reads past comments and blank lines to the revision', () => {
    expect(parseSyncPoint('# a note\n\n  abc123  \n')).toBe('abc123');
    expect(parseSyncPoint('# only comments\n')).toBeUndefined();
    expect(renderSyncPoint('# kept\n\nold\n', 'new')).toBe('# kept\n\nnew\n');
  });
});
