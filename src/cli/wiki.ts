import { isAbsolute, relative, resolve } from 'node:path';
import type { CmdContext, CmdResult } from '@plebeiantech/lat.md-core/context';
import { buildWikiCatalog } from '../wiki/catalog.js';
import { transformWikiCatalog } from '../wiki/transform.js';
import { renderWikiBundle, writeWikiBundle } from '../wiki/render.js';
import {
  publishWiki,
  resolveWikiRemote,
  type WikiRemoteInfo,
} from '../wiki/publish.js';

// @lat: [[cli#CLI#wiki]]
export async function wikiBuildCommand(
  ctx: CmdContext,
  output?: string,
  opts?: { repo?: string; ref?: string },
): Promise<CmdResult> {
  const resolvedOutput = output
    ? resolve(ctx.projectRoot, output)
    : resolve(ctx.projectRoot, '.lat-build/wiki');

  const relToLat = relative(ctx.latDir, resolvedOutput);

  if (
    resolvedOutput === ctx.projectRoot ||
    resolvedOutput === ctx.latDir ||
    (!relToLat.startsWith('..') && !isAbsolute(relToLat))
  ) {
    throw new Error(
      `Refusing to write wiki build output to source directory (${resolvedOutput}).`,
    );
  }

  let remoteInfo: WikiRemoteInfo | undefined;
  if (opts?.repo) {
    try {
      remoteInfo = resolveWikiRemote(ctx.projectRoot, opts.repo);
    } catch (err: unknown) {
      return {
        output: (err as Error).message,
        isError: true,
      };
    }
  } else {
    try {
      remoteInfo = resolveWikiRemote(ctx.projectRoot);
    } catch {
      remoteInfo = undefined;
    }
  }

  const rawCatalog = await buildWikiCatalog(ctx.latDir, ctx.projectRoot);
  if (rawCatalog.docs.length === 0) {
    return {
      output: `No Diátaxis documents found in ${ctx.latDir}.`,
      isError: true,
    };
  }

  const catalog = await transformWikiCatalog(rawCatalog, {
    repoUrl: remoteInfo?.repoUrl,
    ref: opts?.ref,
  });

  const bundle = renderWikiBundle(catalog, { repoName: remoteInfo?.repoName });
  const { writtenFiles } = await writeWikiBundle(resolvedOutput, bundle, {
    clean: true,
  });

  return {
    output: `Built ${catalog.docs.length} Diátaxis page(s) (${writtenFiles.length} file(s)) to ${resolvedOutput}.`,
  };
}

export async function wikiPublishCommand(
  ctx: CmdContext,
  opts?: {
    remote?: string;
    repo?: string;
    ref?: string;
    message?: string;
    dryRun?: boolean;
  },
): Promise<CmdResult> {
  try {
    const result = await publishWiki({
      latDir: ctx.latDir,
      projectRoot: ctx.projectRoot,
      remote: opts?.remote,
      repoUrl: opts?.repo,
      ref: opts?.ref,
      message: opts?.message,
      dryRun: opts?.dryRun,
    });

    if (!result.changed) {
      return {
        output: `Wiki is already up to date (${result.pages} page(s)).`,
      };
    }

    const action = result.pushed
      ? 'Published'
      : 'Built and committed (dry-run)';
    return {
      output: `${action} ${result.pages} Diátaxis page(s) to ${result.wikiRemoteUrl} (${result.commitSha?.slice(0, 7)}).`,
    };
  } catch (err: unknown) {
    return {
      output: (err as Error).message,
      isError: true,
    };
  }
}
