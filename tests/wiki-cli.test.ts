import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmdContext } from '@plebeiantech/lat.md-core/context';
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { wikiBuildCommand, wikiPublishCommand } from '../src/cli/wiki.js';

function execGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function makeFixtureContext(opts: {
  withGit?: boolean;
  withDocs?: boolean;
  withBareWiki?: boolean;
}): {
  root: string;
  ctx: CmdContext;
  bareWikiDir?: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'lat-cli-wiki-'));
  const projectRoot = join(root, 'project');
  const latDir = join(projectRoot, 'lat.md');
  mkdirSync(latDir, { recursive: true });

  let bareWikiDir: string | undefined;

  if (opts.withBareWiki) {
    bareWikiDir = join(root, 'project.wiki.git');
    mkdirSync(bareWikiDir, { recursive: true });
    execGit(['init', '--bare', bareWikiDir]);

    const seed = join(root, 'seed');
    execGit(['clone', bareWikiDir, seed]);
    writeFileSync(join(seed, 'Init.md'), '# Initial page\n');
    execGit(['add', 'Init.md'], seed);
    execGit(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'Init',
      ],
      seed,
    );
    execGit(['push', 'origin', 'HEAD'], seed);
    rmSync(seed, { recursive: true, force: true });
  }

  if (opts.withGit) {
    execGit(['init', projectRoot]);
    if (bareWikiDir) {
      execGit(
        ['remote', 'add', 'origin', bareWikiDir.replace('.wiki.git', '.git')],
        projectRoot,
      );
    }
  }

  writeFileSync(
    join(latDir, 'lat.md'),
    '# Test Project\n\nOverview of the project.\n',
  );

  if (opts.withDocs) {
    const howToDir = join(latDir, 'how-to');
    mkdirSync(howToDir, { recursive: true });
    writeFileSync(
      join(howToDir, 'recipe.md'),
      '# Recipe\n\nRecipe overview.\n\n1. Do this\n',
    );
  }

  const ctx: CmdContext = {
    latDir,
    projectRoot,
    styler: plainStyler,
    mode: 'cli',
  };

  return { root, ctx, bareWikiDir };
}

describe('wikiBuildCommand', () => {
  // @lat: [[wiki#Wiki Tests#Build Command#Builds Diataxis pages to directory]]
  it('builds Diataxis pages into specified directory', async () => {
    const { root, ctx } = makeFixtureContext({ withDocs: true });
    const outputDir = join(root, 'custom-wiki-dist');
    try {
      const res = await wikiBuildCommand(ctx, outputDir);
      expect(res.isError).toBeFalsy();
      expect(res.output).toContain('1 Diátaxis page');
      expect(existsSync(join(outputDir, 'Home.md'))).toBe(true);
      expect(existsSync(join(outputDir, '_Sidebar.md'))).toBe(true);
      expect(existsSync(join(outputDir, 'recipe.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[wiki#Wiki Tests#Build Command#Refuses upstream repository]]
  it('refuses --repo upstream and returns error result', async () => {
    const { root, ctx } = makeFixtureContext({ withDocs: true });
    try {
      const res = await wikiBuildCommand(ctx, undefined, { repo: 'upstream' });
      expect(res.isError).toBe(true);
      expect(res.output).toMatch(/upstream|vercel-labs/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[wiki#Wiki Tests#Build Command#Handles missing git remote cleanly]]
  it('handles missing git remote cleanly when --repo is omitted', async () => {
    const { root, ctx } = makeFixtureContext({
      withGit: false,
      withDocs: true,
    });
    try {
      const res = await wikiBuildCommand(ctx);
      expect(res.isError).toBeFalsy();
      expect(res.output).toContain('1 Diátaxis page');
      expect(
        existsSync(join(ctx.projectRoot, '.lat-build', 'wiki', 'recipe.md')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[wiki#Wiki Tests#Build Command#Reports error when no Diataxis documents exist]]
  it('reports error when no Diataxis documents exist', async () => {
    const { root, ctx } = makeFixtureContext({ withDocs: false });
    try {
      const res = await wikiBuildCommand(ctx);
      expect(res.isError).toBe(true);
      expect(res.output).toMatch(/no diátaxis documents found/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses build output paths inside project root or latDir', async () => {
    const { root, ctx } = makeFixtureContext({ withDocs: true });
    try {
      await expect(wikiBuildCommand(ctx, ctx.projectRoot)).rejects.toThrow(
        /Refusing to write wiki build output to source directory/i,
      );
      await expect(wikiBuildCommand(ctx, ctx.latDir)).rejects.toThrow(
        /Refusing to write wiki build output to source directory/i,
      );
      await expect(
        wikiBuildCommand(ctx, join(ctx.latDir, 'nested')),
      ).rejects.toThrow(
        /Refusing to write wiki build output to source directory/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('wikiPublishCommand', () => {
  // @lat: [[wiki#Wiki Tests#Publish Command#Publishes wiki bundle to remote]]
  it('publishes wiki bundle to remote repository', async () => {
    const { root, ctx, bareWikiDir } = makeFixtureContext({
      withGit: true,
      withDocs: true,
      withBareWiki: true,
    });
    try {
      const res = await wikiPublishCommand(ctx, { remote: bareWikiDir });
      expect(res.isError).toBeFalsy();
      expect(res.output).toMatch(/published 1 diátaxis page/i);

      // Verify remote has files
      const tree = execGit(
        ['ls-tree', '--name-only', 'HEAD'],
        bareWikiDir,
      ).split('\n');
      expect(tree).toContain('Home.md');
      expect(tree).toContain('recipe.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[wiki#Wiki Tests#Publish Command#Dry run commits locally without pushing]]
  it('dry-run commits locally without pushing to remote', async () => {
    const { root, ctx, bareWikiDir } = makeFixtureContext({
      withGit: true,
      withDocs: true,
      withBareWiki: true,
    });
    try {
      const headBefore = execGit(['rev-parse', 'HEAD'], bareWikiDir);
      const res = await wikiPublishCommand(ctx, {
        remote: bareWikiDir,
        dryRun: true,
      });
      expect(res.isError).toBeFalsy();
      expect(res.output).toMatch(/dry-run/i);

      const headAfter = execGit(['rev-parse', 'HEAD'], bareWikiDir);
      expect(headAfter).toBe(headBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
