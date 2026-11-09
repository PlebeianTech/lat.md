import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findWorktreeRoot,
  worktreeRoots,
} from '../src/fork/usage/sources/worktrees.js';

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'usage-worktrees-')));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('worktree helpers', () => {
  // @lat: [[usage-source-codex#Usage Source Codex#Worktree helpers find roots]]
  it('lists the main root and a linked worktree and resolves roots', async () => {
    const main = join(scratch, 'main');
    const linked = join(scratch, 'linked');
    mkdirSync(main);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { stdio: 'ignore' },
      );
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', linked);
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    mkdirSync(join(linked, 'lib'));

    expect((await worktreeRoots(main)).sort()).toEqual([linked, main].sort());
    expect(await worktreeRoots(join(scratch, 'not-a-repo'))).toEqual([
      join(scratch, 'not-a-repo'),
    ]);

    const cache = new Map<string, string>();
    expect(findWorktreeRoot(join(main, 'src', 'deep'), cache)).toBe(main);
    expect(findWorktreeRoot(join(linked, 'lib'), cache)).toBe(linked);
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    expect(findWorktreeRoot(outside, cache)).toBe(outside);
  });
});
