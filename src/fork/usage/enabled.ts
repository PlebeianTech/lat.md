import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]

export function usageDirectory(root: string): string {
  return join(root, '.lat', 'usage');
}

/** A symlinked `.lat` or `.lat/usage` from a cloned repository is not opt-in. */
export function usageEnabled(root: string): boolean {
  return process.env.LAT_USAGE === '1' || realUsageDirectory(root) !== null;
}

export const NOT_ENABLED_MESSAGE =
  'Usage tracking is not enabled; run `lat usage enable` to turn it on.';

/** True when the path itself is a symlink, whatever it points to. */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True for a directory itself; false for a symlink, even to a directory. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `.lat/usage`, and the `below` path inside it, when every part from `.lat`
 * down is a real directory. A cloned repository can ship symlinks there that
 * point outside it, so writers write nothing when this is null.
 */
export function realUsageDirectory(
  root: string,
  ...below: string[]
): string | null {
  let dir = root;
  for (const part of ['.lat', 'usage', ...below]) {
    dir = join(dir, part);
    if (!isRealDirectory(dir)) return null;
  }
  return dir;
}

/**
 * Opens `path` for reading only when it is a regular file. A cloned repository
 * can plant a symlink there, which O_NOFOLLOW refuses. Git cannot store a FIFO
 * or device, but local tampering can put one there (`/dev/zero` never ends), so
 * O_NONBLOCK keeps a FIFO from blocking and fstat refuses anything not a
 * regular file. Throws on refusal; the caller closes the descriptor.
 */
export function openRegularFile(path: string): number {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error(`${path} is not a regular file`);
  }
  return fd;
}

/** The text of a regular file; throws for anything `openRegularFile` refuses. */
export function readRegularFile(path: string): string {
  const fd = openRegularFile(path);
  try {
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

const IGNORE_ALL = '*\n';

/**
 * Makes `.gitignore` hold exactly `*`. A repository can commit one with other
 * content, so anything else is replaced: through a fresh temporary file ('wx'
 * adds O_EXCL, which refuses a symlink) renamed over it, never through a link.
 */
function ignoreAll(dir: string): void {
  const path = join(dir, '.gitignore');
  try {
    if (readRegularFile(path) === IGNORE_ALL) return;
  } catch {
    // Missing, unreadable, or not a regular file: replace it below.
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    unlinkSync(temporary);
  } catch {
    // No stale temporary file.
  }
  writeFileSync(temporary, IGNORE_ALL, { flag: 'wx' });
  renameSync(temporary, path);
}

/** Throws when `.lat` or `.lat/usage` is a symlink or not a directory. */
export function ensureUsageDirectory(root: string): string {
  mkdirSync(root, { recursive: true });
  let dir = root;
  for (const part of ['.lat', 'usage']) {
    dir = join(dir, part);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (!isRealDirectory(dir)) throw new Error(`${dir} is not a directory`);
  }
  ignoreAll(dir);
  return dir;
}

/** Null when `.lat/usage/` does not exist or is not a real directory. */
export function existingUsageDirectory(root: string): string | null {
  const dir = realUsageDirectory(root);
  if (dir === null) return null;
  ignoreAll(dir);
  return dir;
}
