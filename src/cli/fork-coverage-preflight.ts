import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { MarkdownProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import { extractCodeRefTargets } from '@plebeiantech/lat.md-core/code-refs';
import { isSourceFileExtension } from '@plebeiantech/lat.md-core/source-formats';
import {
  normalizeRepositoryPath,
  repositoryFilePath,
} from '@plebeiantech/lat.md-core/repository-path';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import { cleanUntrustedId } from '@plebeiantech/lat.md-core/untrusted';

export const MAX_CANDIDATE_PATHS = 10;

const LEADING_PUNCTUATION_RE = /^['"`\(\)\[\]<>,;:]+/;
const TRAILING_PUNCTUATION_RE = /['"`\(\)\[\]<>,;:\.]+$/;
const SUFFIX_LINE_COL_RE = /:\d+(?::\d+)?$/;
const CONFIG_OR_DECLARATION_RE = /\.(?:config\.[^/]+|d\.[^/]+)$/i;

export function extractCandidateTokens(userPrompt: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const raw of userPrompt.split(/\s+/)) {
    if (!raw) continue;

    let token = raw
      .replace(LEADING_PUNCTUATION_RE, '')
      .replace(TRAILING_PUNCTUATION_RE, '');
    if (!token) continue;

    token = token.replace(SUFFIX_LINE_COL_RE, '');
    const hashIndex = token.indexOf('#');
    if (hashIndex !== -1) {
      token = token.slice(0, hashIndex);
    }

    token = token.replace(TRAILING_PUNCTUATION_RE, '');
    const normalized = normalizeRepositoryPath(token);
    if (!normalized) continue;

    const ext = extname(normalized);
    if (!isSourceFileExtension(ext)) continue;
    if (CONFIG_OR_DECLARATION_RE.test(normalized)) continue;

    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
      if (candidates.length >= MAX_CANDIDATE_PATHS) {
        break;
      }
    }
  }

  return candidates;
}

export function buildWikiGroundedSet(
  wikiRefs: readonly { target: string }[],
): Set<string> {
  const grounded = new Set<string>();
  for (const ref of wikiRefs) {
    const hasHash = ref.target.includes('#');
    const rawTarget = ref.target.split('#')[0];
    const posixTarget = toPosix(rawTarget)
      .trim()
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    const lower = posixTarget.toLowerCase();
    if (!lower || lower === '.') continue;

    const ext = extname(posixTarget);
    if (isSourceFileExtension(ext)) {
      grounded.add(lower);
    } else if (!hasHash) {
      const normalized = normalizeRepositoryPath(posixTarget);
      if (normalized) {
        grounded.add(lower);
      }
    }
  }
  return grounded;
}

export function isPathWikiGrounded(
  relPath: string,
  wikiGroundedSet: ReadonlySet<string>,
): boolean {
  let current = toPosix(relPath).toLowerCase();
  while (current && current !== '.') {
    if (wikiGroundedSet.has(current)) {
      return true;
    }
    const slashIdx = current.lastIndexOf('/');
    if (slashIdx === -1) {
      break;
    }
    current = current.slice(0, slashIdx);
  }
  return false;
}

export async function isFileCodeRefGrounded(
  realPath: string,
): Promise<boolean> {
  try {
    const content = await readFile(realPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (extractCodeRefTargets(line).length > 0) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// @lat: [[cli#CLI#hook#UserPromptSubmit]]
export async function findUngroundedPromptFiles(
  project: MarkdownProjectAnalysis,
  userPrompt: string,
): Promise<string[]> {
  const candidatePaths = extractCandidateTokens(userPrompt);
  if (candidatePaths.length === 0) return [];

  const wikiGroundedSet = buildWikiGroundedSet(project.wikiRefs);
  const ungrounded: string[] = [];

  for (const candidate of candidatePaths) {
    const realPath = await repositoryFilePath(project.projectRoot, candidate);
    if (!realPath) continue;

    if (isPathWikiGrounded(candidate, wikiGroundedSet)) {
      continue;
    }

    const hasCodeRef = await isFileCodeRefGrounded(realPath);
    if (hasCodeRef) {
      continue;
    }

    ungrounded.push(candidate);
  }

  return ungrounded.sort((a, b) => a.localeCompare(b));
}

export function formatCoverageGapNotice(
  ungroundedFiles: readonly string[],
): string | null {
  if (ungroundedFiles.length === 0) return null;

  const fileLines = ungroundedFiles
    .map((file) => `* ${cleanUntrustedId(file)}`)
    .join('\n');

  return (
    'The following source files referenced in the prompt are not yet connected to lat.md/:\n' +
    `${fileLines}\n\n` +
    'If you modify or rely on these files, connect them to the existing lat.md concept section they implement or test via a `// @lat: [[section]]` comment or `[[file#symbol]]` link (do not create a separate prose section per file).'
  );
}
