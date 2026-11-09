import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

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
