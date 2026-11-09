import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]

export function usageDirectory(root: string): string {
  return join(root, '.lat', 'usage');
}

export function usageEnabled(root: string): boolean {
  return process.env.LAT_USAGE === '1' || existsSync(usageDirectory(root));
}

export const NOT_ENABLED_MESSAGE =
  'Usage tracking is not enabled; run `lat usage enable` to turn it on.';

function ignoreAll(dir: string): void {
  try {
    writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

export function ensureUsageDirectory(root: string): string {
  const dir = usageDirectory(root);
  mkdirSync(dir, { recursive: true });
  ignoreAll(dir);
  return dir;
}

/** Null when `.lat/usage/` does not exist. */
export function existingUsageDirectory(root: string): string | null {
  const dir = usageDirectory(root);
  if (!existsSync(dir)) return null;
  ignoreAll(dir);
  return dir;
}
