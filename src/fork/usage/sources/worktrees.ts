import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isInside } from './shell-parse.js';

const run = promisify(execFile);

export async function worktreeRoots(repoRoot: string): Promise<string[]> {
  const roots = [repoRoot];
  try {
    const { stdout } = await run(
      'git',
      ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf-8' },
    );
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) roots.push(line.slice(9));
    }
  } catch {
    return roots;
  }
  return [...new Set(roots)];
}

export function findWorktreeRoot(
  cwd: string,
  cache: Map<string, string>,
): string {
  const cached = cache.get(cwd);
  if (cached) return cached;
  let dir = cwd;
  while (!existsSync(join(dir, '.git'))) {
    const parent = dirname(dir);
    if (parent === dir) {
      dir = cwd;
      break;
    }
    dir = parent;
  }
  cache.set(cwd, dir);
  return dir;
}

/**
 * True when a session's cwd belongs to the project: it sits under one of the
 * project's worktree roots and is not inside a separate git repository nested
 * below that root. A cwd with no enclosing repository still belongs.
 */
export function belongsToProject(
  roots: string[],
  cwd: string,
  cache: Map<string, string>,
): boolean {
  if (!roots.some((r) => isInside(r, cwd))) return false;
  const gitRoot = findWorktreeRoot(cwd, cache);
  if (roots.includes(gitRoot) || !existsSync(join(gitRoot, '.git')))
    return true;
  return !roots.some((r) => isInside(r, gitRoot));
}
