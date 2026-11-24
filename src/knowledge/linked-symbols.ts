// The code symbols a lat.md document links, such as [[src/auth.ts#login]].
// Reads wiki links only: it never parses source files.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractRefs } from '@plebeiantech/lat.md-core/lattice';
import { isSourceFilePath } from '@plebeiantech/lat.md-core/source-formats';
import type { CodeSymbol } from './callers.js';

/** Most symbols taken from one document. */
export const MAX_SYMBOLS_PER_DOC = 10;

/**
 * The source-code symbol links of the project-relative markdown file
 * `docId`, in link order, at most MAX_SYMBOLS_PER_DOC. A symbol linked more
 * than once counts once, at its first link. Returns [] when the file cannot
 * be read.
 */
export async function linkedSymbols(
  projectRoot: string,
  docId: string,
): Promise<CodeSymbol[]> {
  const filePath = join(projectRoot, docId);
  let refs;
  try {
    refs = extractRefs(
      filePath,
      await readFile(filePath, 'utf-8'),
      projectRoot,
    );
  } catch {
    return [];
  }
  const symbolsByTarget = new Map<string, CodeSymbol>();
  for (const { target } of refs) {
    const hash = target.indexOf('#');
    if (hash === -1 || symbolsByTarget.has(target)) continue;
    const file = target.slice(0, hash);
    const name = target.slice(hash + 1);
    if (name === '' || !isSourceFilePath(file)) continue;
    symbolsByTarget.set(target, { file, name });
  }
  return [...symbolsByTarget.values()].slice(0, MAX_SYMBOLS_PER_DOC);
}
