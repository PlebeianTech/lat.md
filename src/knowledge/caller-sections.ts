// Finds the lat.md sections linked to code symbols. Never throws.
import { join } from 'node:path';
import { CheckRunContext } from '@plebeiantech/lat.md-core/cli/check-context';
import { resolveRef } from '@plebeiantech/lat.md-core/lattice';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import { symbolRange } from '../cli/impact.js';
import type { CodeSymbol } from './callers.js';

/**
 * The ids of the sections linked to any of the symbols, without duplicates.
 * A section is linked when a `@lat:` comment sits inside the symbol's line
 * range or in the comment block directly above it, or when a lat.md/ wiki
 * link targets the symbol. A symbol name is written as lat writes it after
 * `#`, for example `Class#method`. Pass `run` to reuse a project analysis
 * the caller already holds.
 */
export async function findSectionsLinkedToSymbols(
  projectRoot: string,
  symbols: CodeSymbol[],
  run?: CheckRunContext,
): Promise<string[]> {
  try {
    run ??= new CheckRunContext(join(projectRoot, 'lat.md'), projectRoot);
    const [project, codeRefs] = await Promise.all([
      run.project(),
      run.codeRefs(),
    ]);
    const sectionIds = new Set(project.sectionIds);
    const canonicalId = (target: string): string | undefined => {
      const { resolved, ambiguous } = resolveRef(
        target,
        sectionIds,
        project.fileIndex,
        project.slugIndex,
      );
      return ambiguous
        ? undefined
        : project.sectionById.get(resolved.toLowerCase())?.id;
    };

    const linked = new Set<string>();
    for (const symbol of symbols) {
      try {
        const file = toPosix(symbol.file);
        const range = await symbolRange(
          projectRoot,
          file,
          symbol.name.split('#'),
        );
        if (range === undefined) continue;
        for (const ref of codeRefs.refs) {
          if (toPosix(ref.file) !== file) continue;
          if (ref.line < range.startLine || ref.line > range.endLine) continue;
          const id = canonicalId(ref.target);
          if (id !== undefined) linked.add(id);
        }
        const symbolTarget = `${file}#${symbol.name}`;
        for (const ref of project.wikiRefs) {
          if (ref.target !== symbolTarget) continue;
          linked.add(canonicalId(ref.fromSection) ?? ref.fromSection);
        }
      } catch {
        // An unparseable file or unknown symbol links nothing.
      }
    }
    return [...linked].sort();
  } catch {
    return [];
  }
}
