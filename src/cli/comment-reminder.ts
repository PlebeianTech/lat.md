import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Ports `hooks/comment-docref-reminder.sh` from the Diátaxis plugin into a
 * lat.md hook event. The read side of lat.md surfaces knowledge behind a
 * `// @lat:` pointer that already exists; nothing acts on WRITING one, so an
 * agent that writes a nine-line rationale comment gets no signal at all — the
 * write succeeds and looks correct. This is that missing half.
 *
 * Deliberately a reminder, not a gate: it always resolves without throwing,
 * and the caller (`hookCmd`) always exits 0. Judging whether a comment
 * explains WHY is not mechanically decidable, so the decision stays with the
 * model — this only guarantees the question gets asked, once per file per
 * session.
 */

export type CommentFamily = {
  /** Matches the file's basename (Rakefile, Dockerfile, etc. carry the
   * language in the name, not an extension, so this matches on basename). */
  basenameRe: RegExp;
  /** A line that opens or continues a comment in this family. */
  commentRe: RegExp;
  /** Machine directives (shebangs, magic comments, linter/type pragmas) that
   * are not prose and can never move into a doc. */
  pragmaRe: RegExp;
  /** The `@lat:` marker syntax for this family, e.g. `#` or `//`. */
  marker: string;
};

const FAMILIES: CommentFamily[] = [
  // Ruby, Python, shell, Rake, Dockerfile, Make, Terraform, YAML, TOML
  {
    basenameRe:
      /^(.*\.(rb|rake|py|sh|bash|zsh|dockerfile|mk|tf|tfvars|yml|yaml|toml)|Rakefile|Dockerfile(\..*)?|Makefile|makefile|GNUmakefile)$/,
    commentRe: /^\s*#/,
    pragmaRe:
      /^\s*#\s*(frozen_string_literal|encoding|coding[:=]|typed|rubocop|standard|:nodoc:|-\*-|type:|noqa|pylint|pyright|pragma:|fmt:|mypy:|ruff:|isort:|shellcheck|syntax=|escape=|tflint-ignore|yamllint|checkov:|terraform-docs)/,
    marker: '#',
  },
  // TS/JS, Rust, Java, Go, C/C++, Kotlin, Swift, PHP, Scala. The `{/*` arm is
  // JSX in practice but costs nothing elsewhere. Rust `///`/`//!` and Java
  // `/**` are deliberately in scope — a doc comment explaining why is still
  // prose that belongs in a doc with a pointer behind it.
  //
  // A bare `*` only opens/continues a comment when followed by whitespace, a
  // slash, or end of line — otherwise `*count += 1;` (a pointer dereference)
  // reads as a comment.
  {
    basenameRe:
      /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|java|go|kt|kts|swift|php|scala|sc|c|h|cc|cpp|cxx|hpp|hh|hxx|m|mm)$/,
    commentRe: /^\s*(\/\/|\/\*|\{\/\*|\*([\s/]|$))/,
    pragmaRe:
      /^\s*(\/\/|\/\*)\s*(eslint|prettier-ignore|biome-ignore|istanbul|c8 |v8 |@ts-|<reference|CHECKSTYLE|NOPMD|\$NON-NLS|go:|\+build|nolint|clang-format|NOLINT|IWYU|swiftlint:|ktlint-|phpcs:|psalm-|@codingStandardsIgnore)/,
    marker: '//',
  },
  // SQL. `#` is there for the MySQL dialect, which accepts it alongside `--`.
  {
    basenameRe: /\.sql$/,
    commentRe: /^\s*(--|\/\*|#|\*([\s/]|$))/,
    pragmaRe: /^\s*(--|#)\s*(noqa|sqlfluff|sqlformat)/,
    marker: '--',
  },
];

export function matchFamily(filePath: string): CommentFamily | null {
  const base = basename(filePath);
  for (const family of FAMILIES) {
    if (family.basenameRe.test(base)) return family;
  }
  return null;
}

export type ToolInput = {
  file_path?: string;
  content?: string;
  new_string?: string;
  edits?: { new_string?: string }[];
};

/** Line multiset of the file as it stands before the tool call, or `null`
 * when there is no readable file — a brand-new path, a permission error, a
 * payload naming no file. Every line is new against a file that is not
 * there. */
function lineCounts(filePath?: string): Map<string, number> | null {
  if (!filePath) return null;
  let onDisk: string;
  try {
    onDisk = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const counts = new Map<string, number>();
  for (const line of onDisk.split('\n')) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** The lines of one written fragment that the file does not already hold.
 * Compared as a multiset, so a fragment emitting a line twice against a file
 * holding it once keeps one of them. The tally is copied per fragment rather
 * than shared across a `MultiEdit`: two hunks that each re-emit the same
 * surrounding comment are both re-emitting it, and charging the second one
 * for it would deny exactly the edit this is here to allow. */
function addedLines(
  written: string,
  onDisk: Map<string, number> | null,
): string {
  if (!onDisk) return written;
  const unclaimed = new Map(onDisk);
  const added: string[] = [];
  for (const line of written.split('\n')) {
    const left = unclaimed.get(line) ?? 0;
    if (left > 0) unclaimed.set(line, left - 1);
    else added.push(line);
  }
  return added.join('\n');
}

/** Only the NEW text — every shape diffed against the file on disk, which at
 * PreToolUse is still the pre-edit state.
 *
 * A `Write` carries the whole file, so counting `content` as written fired on
 * every pre-existing comment and refused rewrites that changed nothing at
 * all. An `Edit` looks like a delta but is not one: `new_string` re-emits the
 * unchanged lines bracketing the change, so editing code next to a doc
 * comment counted that comment as freshly written prose. That denial has no
 * remediation — there is nothing to move — and its only exits are deleting
 * the comment or exempting it line by line. */
export function extractWrittenText(toolInput: ToolInput): string {
  const onDisk = lineCounts(toolInput.file_path);
  const parts: string[] = [];
  if (typeof toolInput.content === 'string')
    parts.push(addedLines(toolInput.content, onDisk));
  if (typeof toolInput.new_string === 'string')
    parts.push(addedLines(toolInput.new_string, onDisk));
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (typeof edit?.new_string === 'string')
        parts.push(addedLines(edit.new_string, onDisk));
    }
  }
  return parts.join('\n');
}

/** Explicit, reviewable per-line opt-out, spelled the same as the token
 * [[src/code-refs.ts]] already honours so a project has one escape hatch to
 * learn rather than two. It lives here, not in the guard, because the
 * advisory and blocking halves have to agree on it: an exemption that the
 * gate honours but the reminder does not just relocates the nag.
 * It suppresses only the line it appears on, keeping a deliberate exception
 * visible in the diff instead of silently disarming the convention for a
 * whole file. */
export const LAT_IGNORE_RE = /(?<![\w])lat:ignore(?![-\w])/;

/** Comment lines worth reminding about. Dropped before counting:
 *   - a line that already carries a `@lat:` pointer (the compliant state)
 *   - a line carrying the explicit opt-out token
 *   - machine directives: shebangs, magic comments, linter/type pragmas
 *   - decoration with no alphanumeric character (`# ----`, `//////`, a bare
 *     `*​/` closing a block) */
export function candidateCommentLines(
  written: string,
  family: CommentFamily,
): string[] {
  return written
    .split('\n')
    .filter((line) => family.commentRe.test(line))
    .filter((line) => !line.includes('@lat:'))
    .filter((line) => !LAT_IGNORE_RE.test(line))
    .filter((line) => !/^\s*#!/.test(line))
    .filter((line) => !family.pragmaRe.test(line))
    .filter((line) => /[a-zA-Z0-9]/.test(line));
}

/** Resolvable project root, required so a scratch file in /tmp is not treated
 * as a project. `cwd` is preferred (matches CLAUDE_PROJECT_DIR / payload cwd
 * conventions); falls back to `git rev-parse --show-toplevel`. */
export function resolveProjectRoot(
  filePath: string,
  payloadCwd?: string,
): string | null {
  if (payloadCwd) return payloadCwd;
  try {
    const dir = dirname(filePath);
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function hasLatTree(projectRoot: string): boolean {
  try {
    return statSync(join(projectRoot, 'lat.md')).isDirectory();
  } catch {
    return false;
  }
}

/** Once per file per session. A private per-user temp dir; if a marker
 * already exists (or can't be checked), the caller treats it as "already
 * reminded" only when the file actually exists, never on error — a dedup
 * failure should fire the reminder again, not suppress it forever. */
function alreadyReminded(
  sessionId: string,
  filePath: string,
): {
  seen: boolean;
  markAsSeen: () => void;
} {
  const noop = { seen: false, markAsSeen: () => {} };
  try {
    const dir = join(
      tmpdir(),
      `lat-comment-reminder-${process.getuid?.() ?? 0}`,
    );
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // Refuse a symlinked or world-writable directory — same reasoning as
      // lib.sh's private_dir: dedup state must not be steerable by another
      // user on a shared machine.
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || (st.mode & 0o022) !== 0) return noop;
    }
    const hash = createHash('sha256')
      .update(`${sessionId}:${filePath}`)
      .digest('hex');
    const marker = join(dir, hash);
    if (existsSync(marker)) return { seen: true, markAsSeen: () => {} };
    return {
      seen: false,
      markAsSeen: () => {
        try {
          writeFileSync(marker, '');
        } catch {
          // best-effort — a missed marker just means the reminder repeats
        }
      },
    };
  } catch {
    return noop;
  }
}

function buildMessage(opts: {
  base: string;
  count: number;
  marker: string;
  hasTree: boolean;
}): string {
  const where = opts.hasTree
    ? '  1. Move it — verbatim is fine, it does not need rewriting — into a\n' +
      '     lat.md/ section describing this behavior, decision, or design\n' +
      '     intent. Use `lat search`/`lat locate` to find where it belongs;\n' +
      '     create a new section only if nothing existing fits.'
    : '  1. This project has no lat.md/ tree yet. Run `lat init` to create one\n' +
      '     (or create lat.md/ by hand), then put the prose in a section there.';

  return (
    `lat.md convention: you just wrote ${opts.count} comment line(s) in ${opts.base}.\n\n` +
    'A code comment states a bare fact only — a unit, a bound, what null means, ' +
    'an issue id, or an `@lat:` pointer. If a comment explains WHY (a reason, a ' +
    "trade-off, a rejected alternative, a constraint, or an invariant's " +
    'rationale) then it is documentation, not a comment.\n\n' +
    'If any of what you just wrote explains why:\n' +
    `${where}\n` +
    '  2. Leave a pointer behind in the code:\n' +
    `       ${opts.marker} @lat: [[section-id]]\n\n` +
    'Never narrate what the code does: if a reader could write the comment ' +
    'from the code alone, delete it.'
  );
}

export type PostToolUseInput = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: ToolInput;
};

/**
 * Computes the reminder context for a single Edit/Write call, or `null` if
 * nothing warrants one. Pure and synchronous so it's trivial to unit test —
 * all the fallible bits (fs, git, marker dedup) are wrapped internally and
 * degrade to "say nothing" or "say it again", never to a thrown error.
 */
export function computeCommentReminder(input: PostToolUseInput): string | null {
  const toolInput = input.tool_input ?? {};
  const filePath = toolInput.file_path;
  if (!filePath) return null;
  if (/\.md$/i.test(filePath)) return null;

  const family = matchFamily(filePath);
  if (!family) return null;

  const written = extractWrittenText(toolInput);
  if (!written) return null;

  // A single-line comment ("// increment the counter") almost always states
  // a bare fact, not a rationale — the acceptance case for this hook. Only a
  // multi-line block is treated as prose worth a reminder; the model still
  // makes the real judgment call, this just filters the overwhelmingly
  // common one-liner before it ever reaches that question.
  const candidates = candidateCommentLines(written, family);
  if (candidates.length < 2) return null;

  const sessionId = input.session_id;
  let dedup: { seen: boolean; markAsSeen: () => void } | null = null;
  if (sessionId) {
    dedup = alreadyReminded(sessionId, filePath);
    if (dedup.seen) return null;
  }

  const projectRoot = resolveProjectRoot(filePath, input.cwd);
  if (!projectRoot) return null;

  const hasTree = hasLatTree(projectRoot);
  const base = basename(filePath);

  const message = buildMessage({
    base,
    count: candidates.length,
    marker: family.marker,
    hasTree,
  });

  dedup?.markAsSeen();
  return message;
}
