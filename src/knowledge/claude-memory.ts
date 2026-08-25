import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Store, StoreQuery, KnowledgeHit } from './types.js';

const CALL_TIMEOUT_MS = 2000;
const MAX_FILE_BYTES = 64 * 1024;

/** Escape regex metacharacters so a raw term can be interpolated safely. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the checkout whose memory store applies to `projectRoot`. Claude
 * Code shares one memory store per repo, keyed on the *main* checkout's
 * absolute path — a worktree has no store of its own. Without resolving to
 * the main checkout, every lookup made from inside a worktree session
 * silently finds nothing, which is invisible unless you know to check: it
 * never errors, it just never matches. `git rev-parse --git-common-dir`
 * inside a worktree returns the main checkout's `.git` dir; its parent is
 * the main checkout. Outside a git repo (or on any failure) we fall back to
 * `projectRoot` itself.
 */
function resolveMainCheckout(projectRoot: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CALL_TIMEOUT_MS,
      encoding: 'utf-8',
    }).trim();
    if (!out) return projectRoot;
    const gitDir = resolve(projectRoot, out);
    return dirname(gitDir);
  } catch {
    return projectRoot;
  }
}

function slugify(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

function memoryDirFor(projectRoot: string): string {
  const mainCheckout = resolveMainCheckout(projectRoot);
  return join(
    homedir(),
    '.claude',
    'projects',
    slugify(mainCheckout),
    'memory',
  );
}

/** Strip a leading/trailing pair of double quotes, if both are present. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** Pull a `key: value` line out of YAML-ish frontmatter, quotes stripped. */
function frontmatterField(text: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const match = re.exec(text);
  return match ? unquote(match[1].trim()) : undefined;
}

function readFileCapped(path: string): string | undefined {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, MAX_FILE_BYTES).toString('utf-8');
  } catch {
    return undefined;
  }
}

async function query(q: StoreQuery): Promise<KnowledgeHit[]> {
  try {
    return rank(q);
  } catch {
    // Unconditional, for the same reason as the bd store: every individual
    // filesystem call below is already guarded, and the contract is worth
    // more than the assumption that the list of them stays complete.
    return [];
  }
}

function rank(q: StoreQuery): KnowledgeHit[] {
  const memoryDir = memoryDirFor(q.projectRoot);
  if (!existsSync(memoryDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = join(memoryDir, entry);
    try {
      // The directory name is derived from a filesystem path; a symlink here
      // could point outside the memory store and leak an unrelated file's
      // contents into a prompt, so symlinks are never followed.
      if (lstatSync(full).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    files.push(full);
  }

  // key -> { text, count }, built in first-seen (readdir) order so ties keep
  // that order after the stable sort below, matching the bd store's rule.
  const seen = new Map<string, { text: string; count: number }>();
  for (const file of files) {
    const text = readFileCapped(file);
    if (text === undefined) continue;
    seen.set(file, { text, count: 0 });
  }

  for (const term of q.terms) {
    if (!term) continue;
    const wordRe = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    for (const v of seen.values()) {
      if (wordRe.test(v.text)) v.count += 1;
    }
  }

  const hits: KnowledgeHit[] = [...seen.entries()]
    .filter(([, v]) => v.count > 0)
    .map(([key, v]) => {
      const name = frontmatterField(v.text, 'name');
      const description = frontmatterField(v.text, 'description');
      const basename = key.slice(memoryDir.length + 1).replace(/\.md$/, '');
      return {
        store: 'claude-memory' as const,
        key,
        title: name ?? basename,
        detail: description ?? '',
        score: v.count,
      };
    });

  hits.sort((a, b) => b.score - a.score);

  return hits.slice(0, q.limit);
}

export const claudeMemoryStore: Store = {
  name: 'claude-memory',
  query,
};
