import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirBestEffort } from './util.js';
import { getStopStatus } from '../src/cli/hook.js';

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

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmDirBestEffort(repo);
});

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeRepoWithCodeChange(fixture: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'lat-stop-reminder-memory-'));
  repos.push(repo);
  cpSync(join(casesDir, fixture), repo, { recursive: true });
  writeFileSync(join(repo, 'lat.md', '.gitignore'), '.cache/\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'app.ts'), 'before\n');
  git(repo, 'init', '--quiet');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  writeFileSync(join(repo, 'src', 'app.ts'), 'changed\n'.repeat(100));
  return repo;
}

function stopStatus(repo: string) {
  return getStopStatus(join(repo, 'lat.md'));
}

describe('stop reminder memory', () => {
  // @lat: [[fork-stop-reminder-memory#Fork Stop Reminder Memory#Unchanged code changes are reminded once]]
  it('reminds once for unchanged code changes', async () => {
    const repo = makeRepoWithCodeChange('hook-clean');

    expect((await stopStatus(repo)).needsSync).toBe(true);

    const second = await stopStatus(repo);
    expect(second.needsSync).toBe(false);
    expect(second.impactedSections).toBeUndefined();
  });

  // @lat: [[fork-stop-reminder-memory#Fork Stop Reminder Memory#New code changes are reminded again]]
  it('reminds again when the code changes again', async () => {
    const repo = makeRepoWithCodeChange('hook-clean');
    await stopStatus(repo);
    expect((await stopStatus(repo)).needsSync).toBe(false);

    appendFileSync(join(repo, 'src', 'app.ts'), 'more\n');

    expect((await stopStatus(repo)).needsSync).toBe(true);
  });

  // @lat: [[fork-stop-reminder-memory#Fork Stop Reminder Memory#Doc edits do not renew the reminder]]
  it('does not remind again when only lat.md/ changes', async () => {
    const repo = makeRepoWithCodeChange('hook-clean');
    expect((await stopStatus(repo)).needsSync).toBe(true);

    appendFileSync(join(repo, 'lat.md', 'feature.md'), '\nMore detail.\n');

    const afterDocEdit = await stopStatus(repo);
    expect(afterDocEdit.latMdLines).toBeGreaterThan(0);
    expect(afterDocEdit.needsSync).toBe(false);
  });

  // @lat: [[fork-stop-reminder-memory#Fork Stop Reminder Memory#Check errors block on every call]]
  it('keeps reporting lat check errors on every call', async () => {
    const repo = makeRepoWithCodeChange('error-broken-links');

    const first = await stopStatus(repo);
    expect(first.checkFailed).toBe(true);
    expect(first.needsSync).toBe(true);

    const second = await stopStatus(repo);
    expect(second.checkFailed).toBe(true);
    expect(second.needsSync).toBe(false);
  });

  // @lat: [[fork-stop-reminder-memory#Fork Stop Reminder Memory#The remembered state stays out of git status]]
  it('keeps the remembered state out of git status', async () => {
    const repo = makeRepoWithCodeChange('hook-clean');
    const statusBefore = git(
      repo,
      'status',
      '--porcelain',
      '--untracked-files=all',
    );

    await stopStatus(repo);
    expect((await stopStatus(repo)).needsSync).toBe(false);

    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(
      statusBefore,
    );
  });
});
