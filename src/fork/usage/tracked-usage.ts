import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isSymlink, readRegularFile, realUsageDirectory } from './enabled.js';

const TRACKED_WARNING =
  'Warning: git tracks files in .lat/usage, so `git commit -a` would commit your usage logs. ' +
  'Run `git rm -r --cached .lat/usage` in the project root to stop tracking them.';

const IGNORE_COMMENT =
  '# lat usage logs hold search queries and local paths: keep out of git';
const IGNORE_ENTRY = '.lat/usage/';
const IGNORES_USAGE = /^\/?\.lat(\/usage)?\/?$/;

// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]
function usageFilesTracked(root: string): boolean {
  if (realUsageDirectory(root) === null) return false;
  try {
    return (
      execFileSync('git', ['ls-files', '--', '.lat/usage'], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim() !== ''
    );
  } catch {
    return false;
  }
}

/** Returns whether it printed the warning. */
export function warnIfUsageTracked(root: string): boolean {
  if (!usageFilesTracked(root)) return false;
  process.stderr.write(`${TRACKED_WARNING}\n`);
  return true;
}

const checkedRoots = new Set<string>();

export function warnOnceIfUsageTracked(root: string): void {
  if (checkedRoots.has(root) || realUsageDirectory(root) === null) return;
  checkedRoots.add(root);
  warnIfUsageTracked(root);
}

// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]
export function ignoreUsageInGit(root: string): void {
  const path = join(root, '.gitignore');
  if (isSymlink(path)) {
    console.log(
      `Left ${path} alone: it is a symlink. Add ${IGNORE_ENTRY} to it yourself.`,
    );
    return;
  }
  try {
    const text = existsSync(path) ? readRegularFile(path) : '';
    if (text.split(/\r?\n/).some((line) => IGNORES_USAGE.test(line.trim())))
      return;
    const newline = text === '' || text.endsWith('\n') ? '' : '\n';
    appendFileSync(path, `${newline}${IGNORE_COMMENT}\n${IGNORE_ENTRY}\n`);
  } catch (error) {
    console.log(
      `Could not update ${path}: ${(error as Error).message}. Add ${IGNORE_ENTRY} to it yourself.`,
    );
  }
}
