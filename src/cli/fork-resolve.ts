import { extname, join } from 'node:path';
import type { Command } from 'commander';
import type { CmdContext } from '@plebeiantech/lat.md-core/context';
import { resolveContext } from '@plebeiantech/lat.md-core/cli/context';
import {
  commandProjectAnalysis,
  commandProjectSession,
} from '@plebeiantech/lat.md-core/project-analysis';
import { resolveRef } from '@plebeiantech/lat.md-core/lattice-model';
import {
  inspectRepositoryPath,
  normalizeRepositoryPath,
  repositoryFilePath,
} from '@plebeiantech/lat.md-core/repository-path';
import { isSourceFileExtension } from '@plebeiantech/lat.md-core/source-formats';
import { resolveSourceSymbol } from '@plebeiantech/lat.md-core/source-parser';

export type ResolvedLink = { file: string; line: number } | { error: string };

/**
 * Turn one wiki-link target into an absolute file path and 1-based line,
 * trying refs in the same order `lat check` validates them.
 */
// @lat: [[cli#resolve]]
export async function resolveLinkTarget(
  ctx: CmdContext,
  ref: string,
): Promise<ResolvedLink> {
  const target = ref.replace(/^\[\[|\]\]$/g, '').split('|')[0];

  const external = await commandProjectSession(ctx).external();
  try {
    if (external.parse(target)) {
      return { error: `external refs are not supported: [[${target}]]` };
    }
  } catch (error) {
    return {
      error: `broken external link [[${target}]] — ${(error as Error).message}`,
    };
  }

  const project = await commandProjectAnalysis(ctx);
  const { resolved, ambiguous } = resolveRef(
    target,
    new Set(project.sectionIds),
    project.fileIndex,
    project.slugIndex,
  );
  if (ambiguous) {
    return {
      error: `ambiguous link [[${target}]] — matches ${ambiguous.map((candidate) => `[[${candidate}]]`).join(', ')}`,
    };
  }
  const section = project.sectionById.get(resolved.toLowerCase());
  if (section) {
    return {
      file: join(ctx.projectRoot, section.filePath),
      line: section.startLine,
    };
  }

  const hashIdx = target.indexOf('#');
  const filePart = hashIdx === -1 ? target : target.slice(0, hashIdx);
  if (isSourceFileExtension(extname(filePart))) {
    return resolveSourceTarget(ctx, target, filePart, hashIdx);
  }

  const path = normalizeRepositoryPath(target);
  if (path) {
    const inspected = await inspectRepositoryPath(ctx.projectRoot, path);
    if (inspected.kind === 'file') {
      return { file: join(ctx.projectRoot, path), line: 1 };
    }
    if (inspected.kind === 'directory') {
      return { error: 'directory refs cannot be opened' };
    }
  }
  return { error: `no section or file found for [[${target}]]` };
}

async function resolveSourceTarget(
  ctx: CmdContext,
  target: string,
  filePart: string,
  hashIdx: number,
): Promise<ResolvedLink> {
  const sourcePath = await repositoryFilePath(ctx.projectRoot, filePart);
  if (!sourcePath) {
    return {
      error: `broken link [[${target}]] — file "${filePart}" not found`,
    };
  }
  if (hashIdx === -1) {
    return { file: join(ctx.projectRoot, filePart), line: 1 };
  }

  const symbolPart = target.slice(hashIdx + 1);
  const { symbols, error } = await resolveSourceSymbol(
    filePart,
    symbolPart,
    ctx.projectRoot,
    commandProjectSession(ctx).sourceSymbolOptions(),
  );
  if (error) return { error: `broken link [[${target}]] — ${error}` };
  const parts = symbolPart.split('#');
  const symbol = symbols.find((s) =>
    parts.length === 1
      ? s.name === parts[0] && !s.parent
      : s.name === parts[1] && s.parent === parts[0],
  );
  if (!symbol) {
    return {
      error: `broken link [[${target}]] — symbol "${symbolPart}" not found in "${filePart}"`,
    };
  }
  return { file: join(ctx.projectRoot, filePart), line: symbol.startLine };
}

export function registerResolveCommand(program: Command): void {
  program
    .command('resolve')
    .description(
      'Print the file and line a wiki-link target opens, as one JSON object',
    )
    .argument('<ref>', 'wiki-link target, with or without [[ ]] and |alias')
    .action(async (ref: string) => {
      const ctx = resolveContext(program.opts());
      const result = await resolveLinkTarget(ctx, ref);
      console.log(JSON.stringify(result));
      if ('error' in result) process.exitCode = 1;
    });
}
