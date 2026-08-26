import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
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
function resolveMainCheckout(projectRoot: string): Promise<string> {
  return new Promise((resolvePromise) => {
    // Async execFile, not execFileSync: this runs on the UserPromptSubmit
    // critical path alongside the bd and cq stores under
    // `Promise.allSettled`, and a synchronous subprocess call here would
    // block the event loop and prevent the other stores' I/O from
    // overlapping with it.
    // `stdio` isn't in the string-encoding overload's declared option type
    // even though Node accepts it at runtime, hence the explicit cast.
    const options = {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CALL_TIMEOUT_MS,
      encoding: 'utf-8',
    } as ExecFileOptionsWithStringEncoding;
    execFile(
      'git',
      ['rev-parse', '--git-common-dir'],
      options,
      (error: ExecFileException | null, stdout: string) => {
        if (error || !stdout) {
          resolvePromise(projectRoot);
          return;
        }
        const out = stdout.trim();
        if (!out) {
          resolvePromise(projectRoot);
          return;
        }
        const gitDir = resolve(projectRoot, out);
        resolvePromise(dirname(gitDir));
      },
    );
  });
}

/**
 * Match Claude Code's own project-directory slug: every character that
 * isn't a letter or digit becomes `-`, including `.` — a project root like
 * `/Users/dave/projects/claude-code/lat.md` slugifies to
 * `-Users-dave-projects-claude-code-lat-md`, verified against a real
 * `~/.claude/projects/` listing. Replacing only `/` (the previous
 * implementation) leaves dots in the slug and never matches the real
 * directory, so the store silently finds nothing for any project root
 * containing a dot.
 */
export function slugify(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// `resolveMainCheckout` spawns `git rev-parse` and `memoryDirFor` is called
// once per matching tag within a single hook invocation, where the project
// root and its main checkout never change mid-process. Memoize on
// `projectRoot` so repeated `rank()` calls in one process spawn git at most
// once per distinct root.
const memoryDirCache = new Map<string, string>();

async function memoryDirFor(projectRoot: string): Promise<string> {
  const cached = memoryDirCache.get(projectRoot);
  if (cached !== undefined) return cached;
  const mainCheckout = await resolveMainCheckout(projectRoot);
  const dir = join(
    homedir(),
    '.claude',
    'projects',
    slugify(mainCheckout),
    'memory',
  );
  memoryDirCache.set(projectRoot, dir);
  return dir;
}

/** Strip a leading/trailing pair of double quotes, if both are present. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** The body of a leading `---` / `---` block, or undefined if there is none. */
function frontmatterBlock(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[1] : undefined;
}

/** Pull a `key: value` line out of YAML-ish frontmatter, quotes stripped. */
function frontmatterField(text: string, key: string): string | undefined {
  const block = frontmatterBlock(text);
  if (block === undefined) return undefined;
  const re = new RegExp(`^${escapeRegExp(key)}:[ \\t]*(.*)$`, 'm');
  const match = re.exec(block);
  return match ? unquote(match[1].trim()) : undefined;
}

function severedTailBytes(buf: Buffer): number {
  for (let back = 1; back <= 3 && back <= buf.length; back++) {
    const byte = buf[buf.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    let width = 0;
    if ((byte & 0xe0) === 0xc0) width = 2;
    else if ((byte & 0xf0) === 0xe0) width = 3;
    else if ((byte & 0xf8) === 0xf0) width = 4;
    return width > back ? back : 0;
  }
  return 0;
}

export function readFileCapped(path: string): string | undefined {
  try {
    const buf = readFileSync(path);
    if (buf.length <= MAX_FILE_BYTES) return buf.toString('utf-8');
    const capped = buf.subarray(0, MAX_FILE_BYTES);
    return capped
      .subarray(0, capped.length - severedTailBytes(capped))
      .toString('utf-8');
  } catch {
    return undefined;
  }
}

async function query(q: StoreQuery): Promise<KnowledgeHit[]> {
  try {
    return await rank(q);
  } catch {
    // Unconditional, for the same reason as the bd store: every individual
    // filesystem call below is already guarded, and the contract is worth
    // more than the assumption that the list of them stays complete.
    return [];
  }
}

// memoryDir -> ordered list of { key, text } for its non-symlinked .md
// files. `federateTags` calls `rank()` once per matching document within a
// single hook invocation, where the memory store on disk cannot change
// between calls — so the directory listing and file contents are read once
// per process and reused, instead of re-stat'ing and re-reading every file
// on every call.
const fileListCache = new Map<string, { key: string; text: string }[]>();

function loadFiles(memoryDir: string): { key: string; text: string }[] {
  const cached = fileListCache.get(memoryDir);
  if (cached !== undefined) return cached;

  let result: { key: string; text: string }[] = [];
  if (existsSync(memoryDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(memoryDir);
    } catch {
      entries = [];
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

    for (const file of files) {
      const text = readFileCapped(file);
      if (text === undefined) continue;
      result.push({ key: file, text });
    }
  }

  fileListCache.set(memoryDir, result);
  return result;
}

async function rank(q: StoreQuery): Promise<KnowledgeHit[]> {
  const memoryDir = await memoryDirFor(q.projectRoot);
  const files = loadFiles(memoryDir);
  if (files.length === 0) return [];

  // key -> { text, count }, built in first-seen (readdir) order so ties keep
  // that order after the stable sort below, matching the bd store's rule.
  const seen = new Map<string, { text: string; count: number }>();
  for (const { key, text } of files) {
    seen.set(key, { text, count: 0 });
  }

  for (const term of q.terms) {
    if (!term) continue;
    // `\b` is ASCII-only in JS regex, so it fails to bound a term like
    // "café" (`\bcafé\b` never matches "a café here"). Lookarounds on
    // "word character" via a Unicode-aware class, with the `u` flag, bound
    // the match without excluding non-ASCII letters.
    const wordRe = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`,
      'iu',
    );
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
