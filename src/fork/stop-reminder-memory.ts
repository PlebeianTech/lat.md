import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { isSourceFileExtension } from '@plebeiantech/lat.md-core/source-formats';
import { stopDiffBase } from './stop-diff-base.js';

const MEMORY_FILE_NAME = 'lat-stop-reminder';

function gitOutputOrEmpty(projectRoot: string, command: string): string {
  try {
    return execSync(command, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function isCountedCodeFile(file: string): boolean {
  return !file.startsWith('lat.md/') && isSourceFileExtension(extname(file));
}

function countLines(projectRoot: string, file: string): number {
  try {
    const path = join(projectRoot, file);
    if (!lstatSync(path).isFile()) return 0;
    const text = readFileSync(path, 'utf-8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

function codeChangesFingerprint(projectRoot: string): string {
  const lines: string[] = [];
  const numstat = gitOutputOrEmpty(
    projectRoot,
    `git diff ${stopDiffBase(projectRoot)} --numstat --relative -- .`,
  );
  for (const line of numstat.split('\n')) {
    const [added, removed, file] = line.split('\t');
    if (file && isCountedCodeFile(file)) {
      lines.push(`${file}, ${added}, ${removed}`);
    }
  }
  const untracked = gitOutputOrEmpty(
    projectRoot,
    'git ls-files --others --exclude-standard -z -- .',
  );
  for (const file of untracked.split('\0')) {
    if (file && isCountedCodeFile(file)) {
      lines.push(`${file}, ${countLines(projectRoot, file)}`);
    }
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

function memoryFilePath(projectRoot: string): string | null {
  const gitPath = gitOutputOrEmpty(
    projectRoot,
    `git rev-parse --git-path ${MEMORY_FILE_NAME}`,
  ).trim();
  if (!gitPath) return null;
  const path = resolve(projectRoot, gitPath);
  return existsSync(dirname(path)) ? path : null;
}

function readRememberedFingerprint(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function rememberFingerprint(path: string, fingerprint: string): void {
  try {
    writeFileSync(path, fingerprint);
  } catch {
    return;
  }
}

// @lat: [[cli#CLI#hook#Stop]]
export function isRepeatedSyncReminder(projectRoot: string): boolean {
  const path = memoryFilePath(projectRoot);
  if (!path) return false;
  const fingerprint = codeChangesFingerprint(projectRoot);
  if (readRememberedFingerprint(path) === fingerprint) return true;
  rememberFingerprint(path, fingerprint);
  return false;
}
