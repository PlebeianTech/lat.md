import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { extractCodeRefTargets } from '@plebeiantech/lat.md-core/code-refs';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import { isSourceFilePath } from '@plebeiantech/lat.md-core/source-formats';
import { cleanUntrustedId } from '@plebeiantech/lat.md-core/untrusted';
import { alreadyReminded } from '../cli/comment-reminder.js';

/** Claude Code's Read returns at most this many lines when no limit is given. */
const DEFAULT_LINE_COUNT = 2000;
const MAX_ADVISED_TARGETS = 5;

/** Targets go inside a double-quoted shell command, so only these characters
 * are allowed. Quotes, `$` and backticks never pass. */
const SHELL_SAFE_TARGET = /^[\p{L}\p{N} #/._\-,:()']+$/u;

/**
 * Advice that tells an agent which lat sections the lines it just read refer
 * to, and which lat commands load them. Names section ids only, never section
 * text. Returns null when there is nothing to advise, and never throws.
 */
export function buildReadRefAdvice(options: {
  projectRoot: string;
  filePath: string;
  firstLine: number;
  lineCount?: number;
  sessionId?: string;
}): string | null {
  try {
    const absolutePath = resolve(options.projectRoot, options.filePath);
    const relativePath = toPosix(relative(options.projectRoot, absolutePath));
    if (relativePath.startsWith('../') || isAbsolute(relativePath)) return null;
    if (relativePath.startsWith('lat.md/')) return null;
    if (!isSourceFilePath(relativePath)) return null;

    const start = options.firstLine - 1;
    const lines = readFileSync(absolutePath, 'utf-8')
      .split('\n')
      .slice(start, start + (options.lineCount ?? DEFAULT_LINE_COUNT));

    const targets = new Set<string>();
    for (const line of lines) {
      for (const target of extractCodeRefTargets(line)) {
        const cleaned = cleanUntrustedId(target.split('|')[0]);
        if (SHELL_SAFE_TARGET.test(cleaned)) targets.add(cleaned);
      }
    }

    let newTargets = [...targets];
    const sessionId = options.sessionId;
    if (sessionId) {
      newTargets = newTargets.filter(
        (target) => !alreadyReminded(sessionId, `read-ref:${target}`).seen,
      );
    }
    if (newTargets.length === 0) return null;

    const advised = newTargets.slice(0, MAX_ADVISED_TARGETS);
    if (sessionId) {
      for (const target of advised) {
        alreadyReminded(sessionId, `read-ref:${target}`).markAsSeen();
      }
    }
    return formatAdvice(advised, newTargets.length - advised.length);
  } catch {
    return null;
  }
}

function formatAdvice(targets: string[], moreCount: number): string {
  const lines = [
    'The lines you read refer to these lat sections.',
    'Before you change that code, run lat section "TARGET" (or the lat_section MCP tool) to read the section, and lat refs "TARGET" to see what depends on it:',
    ...targets.map(
      (target) => `- lat section "${target}"; lat refs "${target}"`,
    ),
  ];
  if (moreCount > 0) {
    lines.push(
      `${moreCount} more referenced section${moreCount === 1 ? ' was' : 's were'} found.`,
    );
  }
  return lines.join('\n');
}
