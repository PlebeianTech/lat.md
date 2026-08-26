import type { CmdContext, CmdResult } from '../context.js';
import {
  buildGraph,
  diffGraphs,
  formatGraph,
  formatGraphDiff,
  loadRevisionFiles,
  loadWorkingTreeFiles,
  type GraphFormat,
} from '../graph-export.js';

export type GraphOptions = {
  format?: string;
  at?: string;
  since?: string;
};

function parseFormat(raw: string | undefined): GraphFormat {
  if (raw === 'mermaid' || raw === 'dot' || raw === 'json') return raw;
  if (raw !== undefined) {
    throw new Error(
      `unknown --format "${raw}" — use one of: json, mermaid, dot`,
    );
  }
  return 'json';
}

export async function graphCommand(
  ctx: CmdContext,
  opts: GraphOptions,
): Promise<CmdResult> {
  let format: GraphFormat;
  try {
    format = parseFormat(opts.format);
  } catch (err) {
    return { output: (err as Error).message, isError: true };
  }

  if (opts.at && opts.since) {
    return {
      output: 'error: `--at` and `--since` cannot be used together',
      isError: true,
    };
  }

  try {
    if (opts.since) {
      const beforeFiles = await loadRevisionFiles(
        ctx.projectRoot,
        ctx.latDir,
        opts.since,
      );
      const afterFiles = await loadWorkingTreeFiles(
        ctx.latDir,
        ctx.projectRoot,
      );
      const before = await buildGraph(beforeFiles, ctx.projectRoot, false);
      const after = await buildGraph(afterFiles, ctx.projectRoot, false);
      return { output: formatGraphDiff(diffGraphs(before, after)) };
    }

    if (opts.at) {
      const files = await loadRevisionFiles(
        ctx.projectRoot,
        ctx.latDir,
        opts.at,
      );
      const graph = await buildGraph(files, ctx.projectRoot, false);
      return { output: formatGraph(graph, format) };
    }

    const files = await loadWorkingTreeFiles(ctx.latDir, ctx.projectRoot);
    const graph = await buildGraph(files, ctx.projectRoot, true);
    return { output: formatGraph(graph, format) };
  } catch (err) {
    return {
      output: `error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
