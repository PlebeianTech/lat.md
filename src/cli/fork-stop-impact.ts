import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { CheckRunContext } from '@plebeiantech/lat.md-core/cli/check-context';
import type { MarkdownProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import type { Section } from '@plebeiantech/lat.md-core/lattice-model';
import type { ScanResult } from '@plebeiantech/lat.md-core/code-refs';
import { resolveRef } from '@plebeiantech/lat.md-core/lattice';
import { isSourceFileExtension } from '@plebeiantech/lat.md-core/source-formats';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import { cleanUntrustedId } from '@plebeiantech/lat.md-core/untrusted';
import { parseSourceSymbols } from '@plebeiantech/lat.md-core/source-parser';
import { findCallers, type CodeSymbol } from '../knowledge/callers.js';
import { findSectionsLinkedToSymbols } from '../knowledge/caller-sections.js';
import { stopDiffBase } from '../fork/stop-diff-base.js';

export type DiffLineRange = {
  file: string;
  startLine: number;
  endLine: number;
};

export function parseUnifiedZeroDiff(diffOutput: string): DiffLineRange[] {
  return parseDiffRanges(diffOutput, (path) =>
    isSourceFileExtension(extname(path)),
  );
}

function parseDiffRanges(
  diffOutput: string,
  keepFile: (path: string) => boolean,
): DiffLineRange[] {
  if (!diffOutput || !diffOutput.trim()) {
    return [];
  }

  const lines = diffOutput.split(/\r?\n/);
  const ranges: DiffLineRange[] = [];
  let currentFile: string | null = null;
  let lastMinusPath: string | null = null;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      let minusPath = line.slice(4).trim().split('\t')[0].trim();
      if (minusPath.startsWith('"') && minusPath.endsWith('"')) {
        minusPath = minusPath.slice(1, -1);
      }
      lastMinusPath = minusPath;
      continue;
    }

    if (line.startsWith('+++ ')) {
      currentFile = null;
      if (line.startsWith('+++ /dev/null')) {
        lastMinusPath = null;
        continue;
      }
      let rawPath = line.slice(4).trim().split('\t')[0].trim();
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        rawPath = rawPath.slice(1, -1);
      }

      if (
        (rawPath.startsWith('b/') && lastMinusPath !== rawPath) ||
        (rawPath.startsWith('a/') &&
          lastMinusPath !== rawPath &&
          lastMinusPath !== '/dev/null')
      ) {
        rawPath = rawPath.replace(/^[ab]\//, '');
      }

      const cleanPath = toPosix(rawPath).replace(/^\.\//, '');
      if (keepFile(cleanPath)) {
        currentFile = cleanPath;
      }
      lastMinusPath = null;
      continue;
    }

    if (currentFile && line.startsWith('@@ ')) {
      const match = line.match(
        /^@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/,
      );
      if (match) {
        const startLine = parseInt(match[1], 10);
        const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        const endLine = Math.max(startLine, startLine + count - 1);
        ranges.push({
          file: currentFile,
          startLine,
          endLine,
        });
      }
    }
  }

  return ranges;
}

function resolveCanonicalSectionId(
  target: string,
  project: MarkdownProjectAnalysis,
): string | undefined {
  if (!target) return undefined;
  const { resolved, ambiguous } = resolveRef(
    target,
    new Set(project.sectionIds),
    project.fileIndex,
    project.slugIndex,
  );
  if (ambiguous) return undefined;
  return project.sectionById.get(resolved.toLowerCase())?.id;
}

function readWorkingTreeDiff(projectRoot: string): string | null {
  try {
    const base = stopDiffBase(projectRoot);
    return execSync(
      `git -c core.quotePath=false diff ${base} --no-color --no-ext-diff --unified=0 --no-prefix --relative -- .`,
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return null;
  }
}

function listUntrackedFiles(projectRoot: string): Set<string> {
  try {
    const output = execSync(
      'git ls-files --others --exclude-standard -z -- .',
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return new Set(output.split('\0').filter(Boolean));
  } catch {
    return new Set();
  }
}

// @lat: [[cli#CLI#hook#Stop]]
export async function findImpactedSectionsForDiff(
  projectRoot: string,
  run: CheckRunContext,
  diffRanges?: DiffLineRange[],
): Promise<string[]> {
  try {
    let ranges = diffRanges;
    if (!ranges) {
      const diffOutput = readWorkingTreeDiff(projectRoot);
      if (diffOutput === null) return [];
      ranges = parseUnifiedZeroDiff(diffOutput);
    }

    if (!ranges || ranges.length === 0) {
      return [];
    }

    const [project, codeRefs] = await Promise.all([
      run.project(),
      run.codeRefs(),
    ]);
    return toListedSectionIds(
      collectLinkedSectionIds(project, codeRefs, ranges),
    );
  } catch {
    return [];
  }
}

export type SectionReviewStatus = {
  linkedSectionCount: number;
  unreviewedSections: string[];
  /**
   * Looks up the unreviewed sections linked to callers of the changed
   * symbols. They never count toward `linkedSectionCount` or
   * `unreviewedSections`. It runs the external callers lookup, so call it
   * only for a reminder that will be shown. Never throws.
   */
  findCallerSections: () => Promise<string[]>;
};

const noCallerSections = async (): Promise<string[]> => [];

function noSectionsLinked(): SectionReviewStatus {
  return {
    linkedSectionCount: 0,
    unreviewedSections: [],
    findCallerSections: noCallerSections,
  };
}

/**
 * Like findImpactedSectionsForDiff, but drops the linked sections whose own
 * lines changed in the working tree, and says how many were linked at all.
 */
// @lat: [[cli#CLI#hook#Stop]]
export async function findUnreviewedSectionsForDiff(
  projectRoot: string,
  run: CheckRunContext,
): Promise<SectionReviewStatus> {
  try {
    const diffOutput = readWorkingTreeDiff(projectRoot);
    if (diffOutput === null) return noSectionsLinked();
    const codeRanges = parseUnifiedZeroDiff(diffOutput);
    if (codeRanges.length === 0) return noSectionsLinked();

    const [project, codeRefs] = await Promise.all([
      run.project(),
      run.codeRefs(),
    ]);
    const linkedIds = collectLinkedSectionIds(project, codeRefs, codeRanges);
    const docRanges = parseDiffRanges(
      diffOutput,
      (path) => extname(path) === '.md',
    );
    const untrackedFiles = listUntrackedFiles(projectRoot);
    const isUnreviewed = (id: string): boolean => {
      const section = project.sectionById.get(id.toLowerCase());
      return !section || !isSectionEdited(section, docRanges, untrackedFiles);
    };
    const unreviewedIds = [...linkedIds].filter(isUnreviewed);

    const findCallerSections = async (): Promise<string[]> => {
      if (unreviewedIds.length === 0 && linkedIds.size > 0) return [];
      try {
        const changedSymbols = await findChangedSymbols(
          projectRoot,
          codeRanges,
        );
        const callerSectionIds = await findCallerSectionIds(
          projectRoot,
          changedSymbols,
          run,
        );
        return toListedSectionIds(
          callerSectionIds.filter(
            (id) => !linkedIds.has(id) && isUnreviewed(id),
          ),
          5,
        );
      } catch {
        return [];
      }
    };
    return {
      linkedSectionCount: linkedIds.size,
      unreviewedSections: toListedSectionIds(unreviewedIds),
      findCallerSections,
    };
  } catch {
    return noSectionsLinked();
  }
}

/** The symbols whose line ranges overlap a changed range of their file. */
async function findChangedSymbols(
  projectRoot: string,
  ranges: DiffLineRange[],
): Promise<CodeSymbol[]> {
  const changedSymbols: CodeSymbol[] = [];
  for (const file of new Set(ranges.map((range) => range.file))) {
    try {
      const content = await readFile(join(projectRoot, file), 'utf-8');
      for (const symbol of await parseSourceSymbols(file, content)) {
        const isChanged = ranges.some(
          (range) =>
            range.file === file &&
            range.startLine <= symbol.endLine &&
            range.endLine >= symbol.startLine,
        );
        if (isChanged) {
          const name = symbol.parent
            ? `${symbol.parent}#${symbol.name}`
            : symbol.name;
          changedSymbols.push({ file, name });
        }
      }
    } catch {
      // An unreadable or unparseable file has no changed symbols.
    }
  }
  return changedSymbols;
}

/** The sections linked to the direct callers of the symbols. */
async function findCallerSectionIds(
  projectRoot: string,
  symbols: CodeSymbol[],
  run: CheckRunContext,
): Promise<string[]> {
  if (symbols.length === 0) return [];
  const callersBySymbol = await findCallers(projectRoot, symbols, { depth: 1 });
  const callers = [...callersBySymbol.values()].flat();
  if (callers.length === 0) return [];
  return findSectionsLinkedToSymbols(projectRoot, callers, run);
}

function isSectionEdited(
  section: Section,
  docRanges: DiffLineRange[],
  untrackedFiles: Set<string>,
): boolean {
  if (untrackedFiles.has(section.filePath)) return true;
  return docRanges.some(
    (range) =>
      range.file === section.filePath &&
      range.startLine <= section.endLine &&
      range.endLine >= section.startLine,
  );
}

function collectLinkedSectionIds(
  project: MarkdownProjectAnalysis,
  codeRefs: ScanResult,
  ranges: DiffLineRange[],
): Set<string> {
  const impactedSet = new Set<string>();

  const rangesByFile = new Map<string, DiffLineRange[]>();
  for (const r of ranges) {
    const normFile = toPosix(r.file).replace(/^\.\//, '');
    const key = normFile.toLowerCase();
    const list = rangesByFile.get(key) ?? [];
    list.push(r);
    rangesByFile.set(key, list);
  }

  const codeRefsByFile = new Map<
    string,
    { file: string; line: number; target: string }[]
  >();
  if (codeRefs && Array.isArray(codeRefs.refs)) {
    for (const cr of codeRefs.refs) {
      const normFile = toPosix(cr.file).replace(/^\.\//, '');
      const key = normFile.toLowerCase();
      const list = codeRefsByFile.get(key) ?? [];
      list.push(cr);
      codeRefsByFile.set(key, list);
    }
  }

  for (const [fileKey, fileRanges] of rangesByFile.entries()) {
    const fileCodeRefs = codeRefsByFile.get(fileKey) ?? [];
    for (const range of fileRanges) {
      const proximityRefs = fileCodeRefs.filter(
        (cr) =>
          cr.line >= range.startLine - 15 && cr.line <= range.endLine + 15,
      );

      if (proximityRefs.length > 0) {
        for (const cr of proximityRefs) {
          const canonicalId = resolveCanonicalSectionId(cr.target, project);
          if (canonicalId) {
            impactedSet.add(canonicalId);
          }
        }
      } else {
        const precedingRefs = fileCodeRefs.filter(
          (cr) => cr.line <= range.endLine,
        );
        if (precedingRefs.length > 0) {
          let maxLine = -1;
          for (const cr of precedingRefs) {
            if (cr.line > maxLine) {
              maxLine = cr.line;
            }
          }
          const nearestPreceding = precedingRefs.filter(
            (cr) => cr.line === maxLine,
          );
          for (const cr of nearestPreceding) {
            const canonicalId = resolveCanonicalSectionId(cr.target, project);
            if (canonicalId) {
              impactedSet.add(canonicalId);
            }
          }
        }
      }
    }
  }

  if (project.wikiRefs && Array.isArray(project.wikiRefs)) {
    for (const ref of project.wikiRefs) {
      if (!ref.fromSection) continue;
      const rawTarget = ref.target.split('#')[0].trim();
      const normTarget = toPosix(rawTarget)
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      if (rangesByFile.has(normTarget.toLowerCase())) {
        const canonicalId =
          resolveCanonicalSectionId(ref.fromSection, project) ??
          ref.fromSection;
        if (canonicalId) {
          impactedSet.add(canonicalId);
        }
      }
    }
  }
  return impactedSet;
}

function toListedSectionIds(ids: Iterable<string>, limit = 10): string[] {
  const sanitized = Array.from(ids).map((id) => cleanUntrustedId(id));
  const unique = Array.from(new Set(sanitized));
  unique.sort((a, b) => a.localeCompare(b));
  return unique.slice(0, limit);
}
