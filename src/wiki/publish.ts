import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { buildWikiCatalog } from './catalog.js';
import { transformWikiCatalog } from './transform.js';
import { renderWikiBundle, writeWikiBundle } from './render.js';

const execFileAsync = promisify(execFile);

export type WikiRemoteInfo = {
  repoName: string;
  repoUrl?: string;
  wikiRemoteUrl: string;
};

export type PublishWikiOptions = {
  latDir: string;
  projectRoot?: string;
  remote?: string;
  repoUrl?: string;
  ref?: string;
  message?: string;
  dryRun?: boolean;
};

export type PublishWikiResult = {
  wikiRemoteUrl: string;
  repoUrl?: string;
  ref: string;
  pages: number;
  writtenFiles: string[];
  removedFiles: string[];
  changed: boolean;
  pushed: boolean;
  commitSha?: string;
};

const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_RE =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_SLUG_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

function redactCredentials(url: string): string {
  return url.replace(/:\/\/[^@/]+@/, '://***@');
}

function assertNotUpstream(target: string): void {
  const lower = target.trim().toLowerCase();
  if (lower === 'upstream' || lower.includes('vercel-labs/lat.md')) {
    throw new Error(
      `Refusing to target upstream repository (vercel-labs/lat.md). Specify your fork repository.`,
    );
  }
}

function parseGitHubUrlOrSlug(
  target: string,
): { owner: string; repo: string; isSsh?: boolean } | null {
  const httpsMatch = target.match(GITHUB_HTTPS_RE);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2], isSsh: false };
  }

  const sshMatch = target.match(GITHUB_SSH_RE);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], isSsh: true };
  }

  if (!isAbsolute(target) && !existsSync(target)) {
    const slugMatch = target.match(GITHUB_SLUG_RE);
    if (slugMatch) {
      return { owner: slugMatch[1], repo: slugMatch[2], isSsh: false };
    }
  }

  return null;
}

export function resolveWikiRemote(
  projectRoot: string,
  remoteOrUrl?: string,
): WikiRemoteInfo {
  if (remoteOrUrl) {
    if (remoteOrUrl.trim().startsWith('-')) {
      throw new Error(`Invalid git remote or URL: ${remoteOrUrl}`);
    }
    assertNotUpstream(remoteOrUrl);
  }

  let resolved = remoteOrUrl;

  // If omitted, default to origin
  if (!resolved) {
    try {
      const originUrl = execFileSync(
        'git',
        ['-C', projectRoot, 'remote', 'get-url', '--', 'origin'],
        {
          encoding: 'utf-8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      ).trim();
      assertNotUpstream(originUrl);
      resolved = originUrl;
    } catch (err: unknown) {
      if ((err as Error).message.includes('Refusing to target upstream')) {
        throw err;
      }
      throw new Error(
        `No remote named 'origin' found in git repository. Specify --remote or --repo.`,
      );
    }
  } else if (
    !resolved.includes('/') &&
    !resolved.includes(':') &&
    !resolved.endsWith('.git')
  ) {
    // Single remote name token
    try {
      const namedUrl = execFileSync(
        'git',
        ['-C', projectRoot, 'remote', 'get-url', '--', resolved],
        {
          encoding: 'utf-8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      ).trim();
      assertNotUpstream(namedUrl);
      resolved = namedUrl;
    } catch (err: unknown) {
      if ((err as Error).message.includes('Refusing to target upstream')) {
        throw err;
      }
      // If remote get-url failed, fall through with the raw token
    }
  }

  assertNotUpstream(resolved);

  const gh = parseGitHubUrlOrSlug(resolved);
  if (gh) {
    const repoName = gh.repo;
    const repoUrl = `https://github.com/${gh.owner}/${gh.repo}`;
    const wikiRemoteUrl = gh.isSsh
      ? `git@github.com:${gh.owner}/${gh.repo}.wiki.git`
      : `https://github.com/${gh.owner}/${gh.repo}.wiki.git`;
    if (wikiRemoteUrl.trim().startsWith('-')) {
      throw new Error(`Invalid wiki remote URL: ${wikiRemoteUrl}`);
    }
    return {
      repoName,
      repoUrl,
      wikiRemoteUrl,
    };
  }

  // Treat as local filesystem path
  let wikiRemoteUrl = resolved;
  if (wikiRemoteUrl.endsWith('.wiki.git')) {
    // already ends with .wiki.git
  } else if (wikiRemoteUrl.endsWith('.git')) {
    wikiRemoteUrl = wikiRemoteUrl.slice(0, -4) + '.wiki.git';
  } else {
    wikiRemoteUrl = `${wikiRemoteUrl}.wiki.git`;
  }

  if (wikiRemoteUrl.trim().startsWith('-')) {
    throw new Error(`Invalid wiki remote URL: ${wikiRemoteUrl}`);
  }

  const base = basename(resolved);
  const repoName = base.replace(/\.wiki\.git$/, '').replace(/\.git$/, '');

  return {
    repoName,
    repoUrl: undefined,
    wikiRemoteUrl,
  };
}

function resolveGitRef(projectRoot: string, explicitRef?: string): string {
  if (explicitRef) return explicitRef;
  try {
    const stdout = execFileSync(
      'git',
      ['-C', projectRoot, 'rev-parse', 'HEAD'],
      {
        encoding: 'utf-8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    ).trim();
    if (stdout) return stdout;
  } catch {
    // ignore
  }
  return 'HEAD';
}

export async function publishWiki(
  options: PublishWikiOptions,
): Promise<PublishWikiResult> {
  const projectRoot = options.projectRoot ?? dirname(options.latDir);
  const remoteInfo = resolveWikiRemote(projectRoot, options.remote);

  if (options.repoUrl) {
    if (options.repoUrl.trim().startsWith('-')) {
      throw new Error(`Invalid repo URL: ${options.repoUrl}`);
    }
    assertNotUpstream(options.repoUrl);
    const gh = parseGitHubUrlOrSlug(options.repoUrl);
    if (gh) {
      remoteInfo.repoUrl = `https://github.com/${gh.owner}/${gh.repo}`;
    }
  }

  if (remoteInfo.wikiRemoteUrl.trim().startsWith('-')) {
    throw new Error(`Invalid wiki remote URL: ${remoteInfo.wikiRemoteUrl}`);
  }

  const ref = resolveGitRef(projectRoot, options.ref);
  const shortSha = ref.slice(0, 7);

  const rawCatalog = await buildWikiCatalog(options.latDir, projectRoot);
  if (rawCatalog.docs.length === 0) {
    throw new Error(
      `No Diataxis documents found in ${options.latDir} to publish.`,
    );
  }

  const catalog = await transformWikiCatalog(rawCatalog, {
    repoUrl: remoteInfo.repoUrl,
    ref,
  });

  const cloneDir = await mkdtemp(join(tmpdir(), 'lat-wiki-clone-'));

  try {
    try {
      await execFileAsync(
        'git',
        ['clone', '--', remoteInfo.wikiRemoteUrl, cloneDir],
        {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );
    } catch (err: unknown) {
      const safeUrl = redactCredentials(remoteInfo.wikiRemoteUrl);
      const safeMsg = redactCredentials((err as Error).message);
      throw new Error(
        `Failed to clone wiki repository (${safeUrl}). ` +
          `GitHub requires enabling Wikis in repository settings and creating the initial page ` +
          `in the repository's Wiki tab before the wiki repository can be cloned or pushed.\n` +
          `${safeMsg}`,
      );
    }

    const bundle = renderWikiBundle(catalog, { repoName: remoteInfo.repoName });
    const { writtenFiles, removedFiles } = await writeWikiBundle(
      cloneDir,
      bundle,
      {
        clean: true,
      },
    );

    const statusOutput = (
      await execFileAsync('git', ['status', '--porcelain'], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    ).stdout.trim();

    if (!statusOutput) {
      return {
        wikiRemoteUrl: remoteInfo.wikiRemoteUrl,
        repoUrl: remoteInfo.repoUrl,
        ref,
        pages: catalog.docs.length,
        writtenFiles,
        removedFiles,
        changed: false,
        pushed: false,
      };
    }

    await execFileAsync('git', ['add', '-A'], {
      cwd: cloneDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const message =
      options.message ?? `Publish Diataxis documentation (${shortSha})`;

    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=lat.md',
        '-c',
        'user.email=lat@users.noreply.github.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        message,
      ],
      {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );

    const commitSha = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    ).stdout.trim();

    if (options.dryRun) {
      return {
        wikiRemoteUrl: remoteInfo.wikiRemoteUrl,
        repoUrl: remoteInfo.repoUrl,
        ref,
        pages: catalog.docs.length,
        writtenFiles,
        removedFiles,
        changed: true,
        pushed: false,
        commitSha,
      };
    }

    try {
      await execFileAsync('git', ['push', 'origin', 'HEAD'], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err: unknown) {
      const safeUrl = redactCredentials(remoteInfo.wikiRemoteUrl);
      const safeMsg = redactCredentials((err as Error).message);
      throw new Error(
        `Failed to push to wiki repository (${safeUrl}): ${safeMsg}`,
      );
    }

    return {
      wikiRemoteUrl: remoteInfo.wikiRemoteUrl,
      repoUrl: remoteInfo.repoUrl,
      ref,
      pages: catalog.docs.length,
      writtenFiles,
      removedFiles,
      changed: true,
      pushed: true,
      commitSha,
    };
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
}
