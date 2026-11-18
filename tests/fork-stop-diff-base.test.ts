import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { rmDirBestEffort } from './util.js';
import { analyzeDiff, getStopStatus } from '../src/cli/hook.js';
import { stopDiffBase } from '../src/fork/stop-diff-base.js';

const casesDir = join(import.meta.dirname, 'cases');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Lat Tests',
  GIT_AUTHOR_EMAIL: 'lat@example.invalid',
  GIT_COMMITTER_NAME: 'Lat Tests',
  GIT_COMMITTER_EMAIL: 'lat@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmDirBestEffort(dir);
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-stop-diff-base-'));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(): string {
  const repo = join(makeTempDir(), 'work');
  cpSync(join(casesDir, 'hook-clean'), repo, { recursive: true });
  writeFileSync(join(repo, 'lat.md', '.gitignore'), '.cache/\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'app.ts'), 'before\n');
  // One valid ref, in a file no later change touches: lat check passes and
  // the diff links no section.
  writeFileSync(
    join(repo, 'src', 'entry.ts'),
    '// @lat: [[feature#Feature]]\n',
  );
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  return repo;
}

function makePushedRepo(): string {
  const repo = makeRepo();
  const remote = join(repo, '..', 'remote.git');
  git(repo, 'init', '--bare', '--quiet', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  return repo;
}

function commitDocsLeaveCodeUncommitted(repo: string): void {
  writeFileSync(join(repo, 'src', 'app.ts'), 'changed\n'.repeat(100));
  appendFileSync(join(repo, 'lat.md', 'feature.md'), '\nMore detail.\n');
  git(repo, 'add', 'lat.md/feature.md');
  git(repo, 'commit', '--quiet', '-m', 'docs');
}

function commitCodeOnly(repo: string): void {
  writeFileSync(join(repo, 'src', 'app.ts'), 'changed\n'.repeat(100));
  git(repo, 'add', 'src/app.ts');
  git(repo, 'commit', '--quiet', '-m', 'code');
}

describe('stop diff base', () => {
  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#Committed doc changes still count]]
  it('counts lat.md/ changes committed since the upstream merge base', () => {
    const repo = makePushedRepo();
    commitDocsLeaveCodeUncommitted(repo);

    const churn = analyzeDiff(repo);
    expect(churn.codeLines).toBeGreaterThanOrEqual(100);
    expect(churn.latMdLines).toBeGreaterThan(0);
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#Committed doc changes still count after a fetch]]
  it('counts committed lat.md/ changes after fetching new upstream commits', () => {
    const repo = makePushedRepo();
    commitDocsLeaveCodeUncommitted(repo);

    const other = join(repo, '..', 'other');
    git(
      repo,
      'clone',
      '--quiet',
      '--branch',
      'main',
      join(repo, '..', 'remote.git'),
      other,
    );
    writeFileSync(join(other, 'unrelated.txt'), 'unrelated\n');
    git(other, 'add', 'unrelated.txt');
    git(other, 'commit', '--quiet', '-m', 'unrelated');
    git(other, 'push', '--quiet');
    git(repo, 'fetch', '--quiet');

    expect(analyzeDiff(repo).latMdLines).toBeGreaterThan(0);
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#Committed code changes still need a sync]]
  it('reminds about code committed since the upstream merge base', async () => {
    const repo = makePushedRepo();
    commitCodeOnly(repo);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const status = await getStopStatus(join(repo, 'lat.md'));
    expect(status.checkFailed).toBe(false);
    expect(status.codeLines).toBeGreaterThanOrEqual(100);
    expect(status.needsSync).toBe(true);
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#Code merged from another branch does not count]]
  it('ignores code merged in from another branch', async () => {
    const repo = makePushedRepo();
    git(repo, 'checkout', '--quiet', '-b', 'other');
    commitCodeOnly(repo);
    git(repo, 'checkout', '--quiet', 'main');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge other', 'other');

    expect(analyzeDiff(repo)).toEqual({ codeLines: 0, latMdLines: 0 });
    const status = await getStopStatus(join(repo, 'lat.md'));
    expect(status.checkFailed).toBe(false);
    expect(status.needsSync).toBe(false);
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#A branch that diverged from its upstream diffs against the merge base]]
  it('diffs against the merge base after the branch diverged from its upstream', () => {
    const repo = makePushedRepo();
    const forkPoint = git(repo, 'rev-parse', 'HEAD').trim();
    commitCodeOnly(repo);
    git(repo, 'push', '--quiet');
    git(repo, 'commit', '--quiet', '--amend', '-m', 'code, rewritten');

    expect(stopDiffBase(repo)).toBe(forkPoint);
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#A branch without an upstream diffs against HEAD]]
  it('diffs against HEAD on a branch without an upstream', async () => {
    const repo = makeRepo();
    expect(stopDiffBase(repo)).toBe('HEAD');

    commitDocsLeaveCodeUncommitted(repo);
    expect(analyzeDiff(repo)).toEqual({ codeLines: 101, latMdLines: 0 });

    git(repo, 'add', 'src/app.ts');
    git(repo, 'commit', '--quiet', '-m', 'code');
    const status = await getStopStatus(join(repo, 'lat.md'));
    expect(status.checkFailed).toBe(false);
    expect(status.codeLines).toBe(0);
    expect(status.needsSync).toBe(false);
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#Outside a git repository there is no churn]]
  it('reports zero churn outside a git repository', () => {
    const dir = join(makeTempDir(), 'project');
    cpSync(join(casesDir, 'hook-clean'), dir, { recursive: true });
    vi.stubEnv('GIT_CEILING_DIRECTORIES', join(dir, '..'));

    expect(stopDiffBase(dir)).toBe('HEAD');
    expect(analyzeDiff(dir)).toEqual({ codeLines: 0, latMdLines: 0 });
  });

  // @lat: [[fork-stop-diff-base#Fork Stop Diff Base#Output that is not an object id falls back to HEAD]]
  it.skipIf(process.platform === 'win32')(
    'falls back to HEAD when git prints something other than an object id',
    () => {
      const repo = makePushedRepo();
      const fakeBinDir = makeTempDir();
      const fakeGit = join(fakeBinDir, 'git');
      writeFileSync(fakeGit, '#!/bin/sh\nprintf "120\\t30\\tsrc/a.ts\\n"\n');
      chmodSync(fakeGit, 0o755);
      vi.stubEnv('PATH', fakeBinDir + delimiter + (process.env.PATH ?? ''));

      expect(stopDiffBase(repo)).toBe('HEAD');
    },
  );
});
