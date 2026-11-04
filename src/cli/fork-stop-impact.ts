import { execSync } from 'node:child_process';
import { extname } from 'node:path';
import type { CheckRunContext } from '@plebeiantech/lat.md-core/cli/check-context';
import type { MarkdownProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import { resolveRef } from '@plebeiantech/lat.md-core/lattice';
import { isSourceFileExtension } from '@plebeiantech/lat.md-core/source-formats';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import { cleanUntrustedId } from '@plebeiantech/lat.md-core/untrusted';

export type DiffLineRange = {
  file: string;
  startLine: number;
  endLine: number;
};

export function parseUnifiedZeroDiff(diffOutput: string): DiffLineRange[] {
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
      const ext = extname(cleanPath);
      if (isSourceFileExtension(ext)) {
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

// @lat: [[cli#CLI#hook#Stop]]
export async function findImpactedSectionsForDiff(
  projectRoot: string,
  run: CheckRunContext,
  diffRanges?: DiffLineRange[],
): Promise<string[]> {
  try {
    let ranges = diffRanges;
    if (!ranges) {
      try {
        const diffOutput = execSync(
          'git diff HEAD --unified=0 --no-prefix --relative -- .',
          {
            cwd: projectRoot,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
        ranges = parseUnifiedZeroDiff(diffOutput);
      } catch {
        return [];
      }
    }

    if (!ranges || ranges.length === 0) {
      return [];
    }

    const [project, codeRefs] = await Promise.all([
      run.project(),
      run.codeRefs(),
    ]);

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

    const sanitized = Array.from(impactedSet).map((id) => cleanUntrustedId(id));
    const unique = Array.from(new Set(sanitized));
    unique.sort((a, b) => a.localeCompare(b));
    return unique.slice(0, 10);
  } catch {
    return [];
  }
}
