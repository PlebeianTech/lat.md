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
import { publishWiki, resolveWikiRemote } from '../src/wiki/publish.js';

function execGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function setupGitFixtures(): {
  root: string;
  projectRoot: string;
  latDir: string;
  bareWikiDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'lat-wiki-pub-'));
  const projectRoot = join(root, 'project');
  const latDir = join(projectRoot, 'lat.md');
  const bareWikiDir = join(root, 'project.wiki.git');

  // 1. Create bare wiki repository and seed initial commit with OldPage.md
  mkdirSync(bareWikiDir, { recursive: true });
  execGit(['init', '--bare', bareWikiDir]);

  const seedCloneDir = join(root, 'seed-clone');
  execGit(['clone', bareWikiDir, seedCloneDir]);
  writeFileSync(join(seedCloneDir, 'OldPage.md'), '# Stale page\n');
  execGit(['add', 'OldPage.md'], seedCloneDir);
  execGit(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Initial wiki',
    ],
    seedCloneDir,
  );
  execGit(['push', 'origin', 'HEAD'], seedCloneDir);
  rmSync(seedCloneDir, { recursive: true, force: true });

  // 2. Create project repository with lat.md
  mkdirSync(latDir, { recursive: true });
  execGit(['init', projectRoot]);
  execGit(
    ['remote', 'add', 'origin', bareWikiDir.replace('.wiki.git', '.git')],
    projectRoot,
  );

  writeFileSync(
    join(latDir, 'lat.md'),
    '# Pub Demo\n\nOverview of the published demo project.\n',
  );

  const howToDir = join(latDir, 'how-to');
  mkdirSync(howToDir, { recursive: true });
  writeFileSync(
    join(howToDir, 'task.md'),
    '# How To Task\n\nTask overview paragraph.\n\n1. Step one\n2. Step two\n',
  );

  execGit(['add', '.'], projectRoot);
  execGit(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Initial project',
    ],
    projectRoot,
  );

  return { root, projectRoot, latDir, bareWikiDir };
}

describe('resolveWikiRemote', () => {
  it('resolves HTTPS, SSH, owner/repo slug, and local filesystem paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-remote-test-'));
    try {
      // Slug
      const slugInfo = resolveWikiRemote(tmp, 'owner/my-repo');
      expect(slugInfo).toEqual({
        repoName: 'my-repo',
        repoUrl: 'https://github.com/owner/my-repo',
        wikiRemoteUrl: 'https://github.com/owner/my-repo.wiki.git',
      });

      // HTTPS
      const httpsInfo = resolveWikiRemote(
        tmp,
        'https://github.com/my-org/my-project.git',
      );
      expect(httpsInfo).toEqual({
        repoName: 'my-project',
        repoUrl: 'https://github.com/my-org/my-project',
        wikiRemoteUrl: 'https://github.com/my-org/my-project.wiki.git',
      });

      // GitHub repo with dots in its name (e.g. lat.md)
      const dotHttps = resolveWikiRemote(
        tmp,
        'https://github.com/PlebeianTech/lat.md.git',
      );
      expect(dotHttps).toEqual({
        repoName: 'lat.md',
        repoUrl: 'https://github.com/PlebeianTech/lat.md',
        wikiRemoteUrl: 'https://github.com/PlebeianTech/lat.md.wiki.git',
      });

      const dotSsh = resolveWikiRemote(
        tmp,
        'git@github.com:PlebeianTech/lat.md.git',
      );
      expect(dotSsh).toEqual({
        repoName: 'lat.md',
        repoUrl: 'https://github.com/PlebeianTech/lat.md',
        wikiRemoteUrl: 'git@github.com:PlebeianTech/lat.md.wiki.git',
      });

      const dotSlug = resolveWikiRemote(tmp, 'PlebeianTech/lat.md');
      expect(dotSlug).toEqual({
        repoName: 'lat.md',
        repoUrl: 'https://github.com/PlebeianTech/lat.md',
        wikiRemoteUrl: 'https://github.com/PlebeianTech/lat.md.wiki.git',
      });

      // Local filesystem path
      const localPath = join(tmp, 'test.wiki.git');
      const localInfo = resolveWikiRemote(tmp, localPath);
      expect(localInfo).toEqual({
        repoName: 'test',
        repoUrl: undefined,
        wikiRemoteUrl: localPath,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses upstream or vercel-labs/lat.md targets including whitespace variants', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-remote-refuse-'));
    try {
      expect(() => resolveWikiRemote(tmp, 'upstream')).toThrow(
        /upstream|vercel-labs/i,
      );
      expect(() => resolveWikiRemote(tmp, '  upstream  ')).toThrow(
        /upstream|vercel-labs/i,
      );
      expect(() => resolveWikiRemote(tmp, 'UPSTREAM')).toThrow(
        /upstream|vercel-labs/i,
      );
      expect(() =>
        resolveWikiRemote(tmp, 'https://github.com/vercel-labs/lat.md.git'),
      ).toThrow(/upstream|vercel-labs/i);
      expect(() =>
        resolveWikiRemote(
          tmp,
          '   https://github.com/vercel-labs/lat.md.git   ',
        ),
      ).toThrow(/upstream|vercel-labs/i);
      expect(() => resolveWikiRemote(tmp, 'vercel-labs/lat.md')).toThrow(
        /upstream|vercel-labs/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects option injection starting with hyphen', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-remote-option-'));
    try {
      expect(() => resolveWikiRemote(tmp, '--upload-pack=evil')).toThrow(
        /invalid/i,
      );
      expect(() => resolveWikiRemote(tmp, '-o')).toThrow(/invalid/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws clear error when remote is omitted and repo has no origin remote', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-remote-no-origin-'));
    try {
      execGit(['init', tmp]);
      expect(() => resolveWikiRemote(tmp)).toThrow(
        /No remote named 'origin' found in git repository\. Specify --remote or --repo\./,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('publishWiki', () => {
  it('clones bare wiki repo, commits rendered bundle, pushes, and removes stale files', async () => {
    const fixture = setupGitFixtures();
    try {
      const result = await publishWiki({
        latDir: fixture.latDir,
        projectRoot: fixture.projectRoot,
        remote: fixture.bareWikiDir,
      });

      expect(result.changed).toBe(true);
      expect(result.pushed).toBe(true);
      expect(result.pages).toBe(1);
      expect(result.writtenFiles).toContain('Home.md');
      expect(result.writtenFiles).toContain('_Sidebar.md');
      expect(result.writtenFiles).toContain('task.md');
      expect(result.removedFiles).toEqual(['OldPage.md']);

      // Inspect bare remote HEAD
      const treeList = execGit(
        ['ls-tree', '--name-only', 'HEAD'],
        fixture.bareWikiDir,
      ).split('\n');
      expect(treeList).toContain('Home.md');
      expect(treeList).toContain('_Sidebar.md');
      expect(treeList).toContain('task.md');
      expect(treeList).not.toContain('OldPage.md');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('detects no-op second publish without creating an extra commit', async () => {
    const fixture = setupGitFixtures();
    try {
      const first = await publishWiki({
        latDir: fixture.latDir,
        projectRoot: fixture.projectRoot,
        remote: fixture.bareWikiDir,
      });
      expect(first.changed).toBe(true);

      const second = await publishWiki({
        latDir: fixture.latDir,
        projectRoot: fixture.projectRoot,
        remote: fixture.bareWikiDir,
      });
      expect(second.changed).toBe(false);
      expect(second.pushed).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('respects dryRun: true by committing locally without pushing to remote', async () => {
    const fixture = setupGitFixtures();
    try {
      const headBefore = execGit(['rev-parse', 'HEAD'], fixture.bareWikiDir);
      const result = await publishWiki({
        latDir: fixture.latDir,
        projectRoot: fixture.projectRoot,
        remote: fixture.bareWikiDir,
        dryRun: true,
      });

      expect(result.changed).toBe(true);
      expect(result.pushed).toBe(false);
      expect(result.commitSha).toBeDefined();

      const headAfter = execGit(['rev-parse', 'HEAD'], fixture.bareWikiDir);
      expect(headAfter).toBe(headBefore); // bare remote was not pushed to
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('throws an actionable error when pointing at a nonexistent wiki remote', async () => {
    const fixture = setupGitFixtures();
    try {
      await expect(
        publishWiki({
          latDir: fixture.latDir,
          projectRoot: fixture.projectRoot,
          remote: join(fixture.root, 'nonexistent.wiki.git'),
        }),
      ).rejects.toThrow(/initial page in the repository's Wiki tab/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('redacts inline credentials in clone and push failure messages', async () => {
    const fixture = setupGitFixtures();
    try {
      const sensitiveRemote =
        'https://secret-user:super-token@github.com/fake-org/fake-repo.wiki.git';
      const promise = publishWiki({
        latDir: fixture.latDir,
        projectRoot: fixture.projectRoot,
        remote: sensitiveRemote,
      });

      await expect(promise).rejects.toThrow();
      try {
        await promise;
      } catch (err: unknown) {
        const msg = (err as Error).message;
        expect(msg).toContain(
          'https://***@github.com/fake-org/fake-repo.wiki.git',
        );
        expect(msg).not.toContain('secret-user');
        expect(msg).not.toContain('super-token');
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects option injection in repoUrl', async () => {
    const fixture = setupGitFixtures();
    try {
      await expect(
        publishWiki({
          latDir: fixture.latDir,
          projectRoot: fixture.projectRoot,
          remote: fixture.bareWikiDir,
          repoUrl: '--upload-pack=evil',
        }),
      ).rejects.toThrow(/invalid/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
