import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  analyzeDrift,
  formatDrift,
  parseMergeTree,
} from '../src/fork/upstream-drift.js';

let repo: string;
let syncPoint: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'drift',
  GIT_AUTHOR_EMAIL: 'drift@example.invalid',
  GIT_COMMITTER_NAME: 'drift',
  GIT_COMMITTER_EMAIL: 'drift@example.invalid',
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

function commit(rel: string, content: string, message: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git('add', '-A');
  git('commit', '-qm', message);
}

function drift() {
  return analyzeDrift({ repo, syncPoint, upstreamRef: 'theirs' });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lat-upstream-drift-'));
  git('init', '-q', '-b', 'main');
  commit('shared.txt', 'one\ntwo\nthree\n', 'shared');
  commit('other.txt', 'other\n', 'other');
  syncPoint = git('rev-parse', 'HEAD').trim();
  git('branch', 'theirs');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

// @lat: [[upstream-guard#The upstream guard#Watching the drift]]
describe('upstream drift', () => {
  it('reports nothing to do when upstream has not moved', () => {
    const result = drift();
    expect(result.ahead).toBe(0);
    expect(result.upstreamFiles).toEqual([]);
    expect(formatDrift(result)).toContain('nothing new');
  });

  it('counts what upstream changed and what both sides changed', () => {
    git('checkout', '-q', 'theirs');
    commit('shared.txt', 'ONE\ntwo\nthree\n', 'upstream edits the top');
    commit('theirs-only.txt', 'theirs\n', 'upstream adds a file');
    git('checkout', '-q', 'main');
    commit('shared.txt', 'one\ntwo\nTHREE\n', 'the fork edits the bottom');
    commit('ours-only.txt', 'ours\n', 'the fork adds a file');

    const result = drift();
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(2);
    expect(result.upstreamFiles).toEqual(['shared.txt', 'theirs-only.txt']);
    expect(result.overlap).toEqual(['shared.txt']);
  });

  it('calls a merge clean when the two edits do not touch', () => {
    // Both sides changed shared.txt, at opposite ends. Overlap is the
    // leading indicator; it is not the same as a conflict today.
    const result = drift();
    expect(result.overlap).toEqual(['shared.txt']);
    expect(result.mergesCleanly).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(formatDrift(result)).toContain('without a textual conflict');
  });

  it('names the conflicting file when the edits collide', () => {
    git('checkout', '-q', 'theirs');
    commit('shared.txt', 'THEIRS\ntwo\nthree\n', 'upstream rewrites line one');
    git('checkout', '-q', 'main');
    commit('shared.txt', 'OURS\ntwo\nTHREE\n', 'the fork rewrites line one');

    const result = drift();
    expect(result.mergesCleanly).toBe(false);
    expect(result.conflicts).toEqual(['shared.txt']);
    expect(formatDrift(result)).toContain('1 conflicting file(s)');
  });

  it('reads paths out of merge-tree output and stops at the log', () => {
    const stdout = [
      'a'.repeat(40),
      'src/one.ts',
      'src/two.ts',
      '',
      'Auto-merging src/one.ts',
      'CONFLICT (content): Merge conflict in src/one.ts',
    ].join('\n');
    expect(parseMergeTree(stdout)).toEqual(['src/one.ts', 'src/two.ts']);
    expect(parseMergeTree('tree-id-only\n')).toEqual([]);
  });
});
