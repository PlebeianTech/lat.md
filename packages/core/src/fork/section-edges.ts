// @lat: [[cli#CLI#section]]

import { isAbsolute, join, relative } from 'node:path';
import { toPosix } from '../path.js';

export type CodeRefRole = 'test' | 'code';

const TEST_DIR_PATTERN = /(?:^|\/)(?:tests|test|__tests__|spec)\//i;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^/]+$/i;

export function classifyCodeRefRole(relFilePath: string): CodeRefRole {
  if (!relFilePath) return 'code';
  const posixPath = toPosix(relFilePath);
  if (TEST_DIR_PATTERN.test(posixPath) || TEST_FILE_PATTERN.test(posixPath)) {
    return 'test';
  }
  return 'code';
}

export function formatIncomingRefLocation(
  projectRoot: string,
  cwd: string,
  file?: string,
  line?: number,
): string {
  if (
    !file ||
    typeof line !== 'number' ||
    line <= 0 ||
    !Number.isFinite(line)
  ) {
    return '';
  }
  const fileWithMd = file.toLowerCase().endsWith('.md') ? file : `${file}.md`;
  const absPath = isAbsolute(fileWithMd)
    ? fileWithMd
    : join(projectRoot, fileWithMd);
  const relPath = toPosix(relative(cwd, absPath));
  return ` (${relPath}:${line})`;
}
