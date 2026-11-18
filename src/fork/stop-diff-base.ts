import { execFileSync } from 'node:child_process';

const FULL_OBJECT_ID = /^[0-9a-f]{40,64}$/;

function git(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// @lat: [[cli#CLI#hook#Stop]]
export function stopDiffBase(projectRoot: string): string {
  try {
    const mergeBase = git(projectRoot, ['merge-base', 'HEAD', '@{upstream}']);
    if (!FULL_OBJECT_ID.test(mergeBase)) return 'HEAD';
    if (git(projectRoot, ['rev-list', '--merges', `${mergeBase}..HEAD`])) {
      return 'HEAD';
    }
    return mergeBase;
  } catch {
    return 'HEAD';
  }
}
