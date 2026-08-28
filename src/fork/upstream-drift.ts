import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseNameStatus,
  parseSyncPoint,
  repoRoot,
  SYNC_POINT_FILE,
  type DiffEntry,
} from './upstream-guard.js';

export const UPSTREAM_URL = 'https://github.com/vercel-labs/lat.md.git';

export const UPSTREAM_REF = 'refs/remotes/upstream/main';

function git(repo: string, args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

export type Drift = {
  upstream: string;
  ahead: number;
  behind: number;
  upstreamFiles: string[];
  forkFiles: string[];
  overlap: string[];
  conflicts: string[];
  mergesCleanly: boolean;
};

/**
 * Conflicting paths from `git merge-tree --write-tree --name-only`, whose
 * output is the written tree id, then one path per line, then a blank line
 * and the human-readable log. Everything after that blank line is prose.
 */
export function parseMergeTree(stdout: string): string[] {
  const lines = stdout.split('\n');
  const paths: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break;
    paths.push(line);
  }
  return paths;
}

function names(diff: DiffEntry[]): string[] {
  return [...new Set(diff.map((d) => d.path))].sort();
}

function diffNames(repo: string, from: string, to: string): string[] {
  const result = git(repo, [
    'diff',
    '--no-renames',
    '--name-status',
    '-z',
    from,
    to,
  ]);
  if (result.status !== 0) {
    throw new Error(`git diff ${from}..${to} failed: ${result.stderr.trim()}`);
  }
  return names(parseNameStatus(result.stdout));
}

function count(repo: string, range: string): number {
  const result = git(repo, ['rev-list', '--count', range]);
  if (result.status !== 0) {
    throw new Error(`git rev-list ${range} failed: ${result.stderr.trim()}`);
  }
  return Number(result.stdout.trim());
}

export function fetchUpstream(repo: string, url: string, ref: string): void {
  const result = git(repo, [
    'fetch',
    '--no-tags',
    url,
    `+refs/heads/main:${ref}`,
  ]);
  if (result.status !== 0) {
    throw new Error(`fetching ${url} failed: ${result.stderr.trim()}`);
  }
}

// @lat: [[upstream-guard#The upstream guard#Watching the drift]]
export function analyzeDrift(opts: {
  repo: string;
  syncPoint: string;
  upstreamRef: string;
}): Drift {
  const root = repoRoot(opts.repo);
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const upstream = git(root, ['rev-parse', opts.upstreamRef]).stdout.trim();

  const upstreamFiles = diffNames(root, opts.syncPoint, upstream);
  const forkFiles = diffNames(root, opts.syncPoint, head);
  const forkSet = new Set(forkFiles);

  const merge = git(root, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    head,
    upstream,
  ]);

  return {
    upstream,
    ahead: count(root, `${opts.syncPoint}..${upstream}`),
    behind: count(root, `${upstream}..${head}`),
    upstreamFiles,
    forkFiles,
    overlap: upstreamFiles.filter((f) => forkSet.has(f)),
    conflicts: merge.status === 0 ? [] : parseMergeTree(merge.stdout),
    mergesCleanly: merge.status === 0,
  };
}

function list(paths: string[]): string[] {
  return paths.map((p) => `- \`${p}\``);
}

export function formatDrift(drift: Drift): string {
  const lines = [`## Upstream drift`, ''];

  if (drift.ahead === 0) {
    lines.push('Upstream has nothing new since the recorded sync point.', '');
    return lines.join('\n');
  }

  lines.push(
    `Upstream is **${drift.ahead} commit(s)** ahead of the sync point, ` +
      `touching **${drift.upstreamFiles.length} file(s)**. This fork has ` +
      `${drift.behind} commit(s) of its own.`,
    '',
    `Upstream tip: \`${drift.upstream.slice(0, 12)}\``,
    '',
  );

  if (drift.mergesCleanly) {
    lines.push('Merges without a textual conflict.', '');
  } else {
    lines.push(
      `### ${drift.conflicts.length} conflicting file(s)`,
      '',
      ...list(drift.conflicts),
      '',
    );
  }

  // A file both sides changed is where the next conflict comes from, even
  // when today's merge is clean.
  lines.push(
    `### ${drift.overlap.length} file(s) changed on both sides`,
    '',
    ...(drift.overlap.length === 0 ? ['None.'] : list(drift.overlap)),
    '',
    'A clean merge is not a working tree. Two additions can collide in the',
    'knowledge graph without conflicting in git, and an upstream type can',
    'widen underneath a fork-owned test. The job checks both after merging.',
    '',
  );

  return lines.join('\n');
}

const USAGE = `Usage: node dist/src/fork/upstream-drift-cli.js [options]

  --repo <dir>          default the current working directory
  --url <git-url>       default ${UPSTREAM_URL}
  --ref <ref>           default ${UPSTREAM_REF}
  --sync-point <rev>    default the recorded sync point
  --no-fetch            use the ref already in the repository
  --fail-on-conflict    exit 1 when the merge would conflict
  -h, --help            this text
`;

export function main(argv: string[]): number {
  const opts = {
    repo: process.cwd(),
    url: UPSTREAM_URL,
    ref: UPSTREAM_REF,
    syncPoint: '',
    fetch: true,
    failOnConflict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg === '--no-fetch') opts.fetch = false;
    else if (arg === '--fail-on-conflict') opts.failOnConflict = true;
    else if (arg === '--repo') opts.repo = argv[++i] ?? '';
    else if (arg === '--url') opts.url = argv[++i] ?? '';
    else if (arg === '--ref') opts.ref = argv[++i] ?? '';
    else if (arg === '--sync-point') opts.syncPoint = argv[++i] ?? '';
    else {
      process.stderr.write(`unknown argument: ${arg}\n\n${USAGE}`);
      return 2;
    }
  }

  try {
    const root = repoRoot(opts.repo);
    if (opts.syncPoint === '') {
      const file = resolve(root, SYNC_POINT_FILE);
      if (!existsSync(file)) {
        process.stderr.write(`upstream-drift: no sync point at ${file}\n`);
        return 2;
      }
      opts.syncPoint = parseSyncPoint(readFileSync(file, 'utf-8')) ?? '';
      if (opts.syncPoint === '') {
        process.stderr.write(`upstream-drift: ${file} holds no revision\n`);
        return 2;
      }
    }

    if (opts.fetch) fetchUpstream(root, opts.url, opts.ref);

    const drift = analyzeDrift({
      repo: root,
      syncPoint: opts.syncPoint,
      upstreamRef: opts.ref,
    });
    process.stdout.write(formatDrift(drift));
    return opts.failOnConflict && !drift.mergesCleanly ? 1 : 0;
  } catch (error) {
    process.stderr.write(`upstream-drift: ${(error as Error).message}\n`);
    return 2;
  }
}
