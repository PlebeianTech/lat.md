import { execFileSync } from 'node:child_process';

const FULL_OBJECT_ID = /^[0-9a-f]{40,64}$/;

// @lat: [[cli#CLI#hook#Stop]]
export function stopDiffBase(projectRoot: string): string {
  try {
    const mergeBase = execFileSync(
      'git',
      ['merge-base', 'HEAD', '@{upstream}'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return FULL_OBJECT_ID.test(mergeBase) ? mergeBase : 'HEAD';
  } catch {
    return 'HEAD';
  }
}
