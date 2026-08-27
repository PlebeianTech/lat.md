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
  old_string?: string;
  new_string?: string;
  edits?: { old_string?: string; new_string?: string }[];
};

/** Line multiset of `text`, used as the baseline a written fragment is new
 * against. */
function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** Baseline taken from the file itself, or `null` when there is no readable
 * file — a brand-new path, a directory, a permission error, a payload naming
 * no file. `null` means every line counts as new, which is what makes an
 * unreadable file fail closed: the gate denies rather than waving the write
 * through on evidence it could not gather. */
function fileBaseline(filePath?: string): Map<string, number> | null {
  if (!filePath) return null;
  try {
    return lineCounts(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Which side of the tool call the caller is on.
 *
 * `'before-write'` — PreToolUse. The file on disk is still the pre-edit state,
 * so it is usable as a baseline for a whole-file `Write`, which carries no
 * other record of what it replaced.
 *
 * `'after-write'` — PostToolUse. The write has landed, so the file contains
 * every line of `content` by construction. Diffing against it there cancels
 * the whole payload and the caller sees nothing at all.
 *
 * An `Edit` carries its own `old_string` and needs neither reading: its
 * baseline is phase-independent, which is the shape to prefer.
 *
 * The parameter is required so a third call site has to answer the question
 * rather than inherit whichever default happened to suit the first two.
 */
export type WritePhase = 'before-write' | 'after-write';

/** A written fragment paired with the text it replaces. `baseline` of `null`
 * means nothing is known to have been there, so every line is new. */
type WrittenFragment = {
  text: string;
  baseline: Map<string, number> | null;
};

/**
 * The fragments one tool call writes, each against the narrowest baseline
 * available for it.
 *
 * `old_string` is preferred over the file wherever the payload carries one,
 * because the file is the wrong scope: matching a written line against
 * *anywhere* in the file forgives a genuinely new block whenever one of its
 * lines happens to duplicate an unrelated line elsewhere. `old_string` is the
 * exact text being replaced, so the difference is the real delta.
 *
 * Baselines are per fragment rather than shared across a `MultiEdit`: two
 * hunks that each re-emit the same surrounding comment are both re-emitting
 * it, and charging the second one for it would deny exactly the edit this is
 * here to allow.
 */
function writtenFragments(
  toolInput: ToolInput,
  phase: WritePhase,
): WrittenFragment[] {
  let diskRead = false;
  let disk: Map<string, number> | null = null;
  const fromFile = (): Map<string, number> | null => {
    if (phase !== 'before-write') return null;
    if (!diskRead) {
      disk = fileBaseline(toolInput.file_path);
      diskRead = true;
    }
    return disk;
  };
  const baselineFor = (oldString?: string): Map<string, number> | null =>
    typeof oldString === 'string' ? lineCounts(oldString) : fromFile();

  const fragments: WrittenFragment[] = [];
  if (typeof toolInput.content === 'string')
    fragments.push({ text: toolInput.content, baseline: fromFile() });
  if (typeof toolInput.new_string === 'string')
    fragments.push({
      text: toolInput.new_string,
      baseline: baselineFor(toolInput.old_string),
    });
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (typeof edit?.new_string === 'string')
        fragments.push({
          text: edit.new_string,
          baseline: baselineFor(edit.old_string),
        });
    }
  }
  return fragments;
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

/** Whether one line is a comment worth counting. Not counted:
 *   - a line that already carries a `@lat:` pointer (the compliant state)
 *   - a line carrying the explicit opt-out token
 *   - machine directives: shebangs, magic comments, linter/type pragmas
 *   - decoration with no alphanumeric character (`# ----`, `//////`, a bare
 *     `*​/` closing a block)
 *
 * Both halves of the convention call this and nothing else, so the gate and
 * the reminder cannot drift apart on what counts as prose. */
export function isCandidateCommentLine(
  line: string,
  family: CommentFamily,
): boolean {
  return (
    family.commentRe.test(line) &&
    !line.includes('@lat:') &&
    !LAT_IGNORE_RE.test(line) &&
    !/^\s*#!/.test(line) &&
    !family.pragmaRe.test(line) &&
    /[a-zA-Z0-9]/.test(line)
  );
}

/** Candidate comment lines in one write before either half reacts. A single
 * line ("// bytes, not chars") is the bare-fact case the convention allows;
 * two is a block of prose. */
const PROSE_THRESHOLD = 2;

export type CommentVerdict = {
  /** Candidate comment lines this call is answerable for. Names the number
   * printed in the denial or the reminder. */
  count: number;
  /** Whether the call warrants a denial from the gate or a reminder from its
   * advisory half. */
  flagged: boolean;
};

/**
 * What one Edit/Write/MultiEdit call did to the comments in a file.
 *
 * Two rules, because neither alone survives contact with an agent:
 *
 * A run of `PROSE_THRESHOLD` or more *adjacent* comment lines is flagged as
 * soon as any one of them is new. Counting only the new lines lets a block be
 * grown one line per `Edit` and never reach the threshold — and the denial
 * text itself recommends `Edit` over `Write`, so the technique is advertised.
 * What matters is the block the edit leaves behind, not the increment.
 *
 * Isolated new comment lines are flagged once `PROSE_THRESHOLD` of them
 * accumulate anywhere in the call. Two one-line comments in different places
 * are still two lines of prose; without this a scattered write walks past the
 * adjacency rule.
 *
 * Neither rule counts a line that was already there, so re-emitting a
 * comment — the whole of a `Write`'s payload, or the lines bracketing an
 * `Edit` — stays free.
 */
export function judgeWrittenComments(
  toolInput: ToolInput,
  family: CommentFamily,
  phase: WritePhase,
): CommentVerdict {
  const fragments = writtenFragments(toolInput, phase);
  if (!fragments.some((fragment) => fragment.text !== ''))
    return { count: 0, flagged: false };

  let inFlaggedRuns = 0;
  let isolatedNew = 0;

  for (const fragment of fragments) {
    const lines = fragment.text.split('\n');
    const unclaimed = fragment.baseline ? new Map(fragment.baseline) : null;
    const isNew: boolean[] = [];
    const isComment: boolean[] = [];
    for (const line of lines) {
      let fresh = true;
      if (unclaimed) {
        const left = unclaimed.get(line) ?? 0;
        if (left > 0) {
          unclaimed.set(line, left - 1);
          fresh = false;
        }
      }
      isNew.push(fresh);
      isComment.push(isCandidateCommentLine(line, family));
    }

    let i = 0;
    while (i < lines.length) {
      if (!isComment[i]) {
        i += 1;
        continue;
      }
      let end = i;
      while (end < lines.length && isComment[end]) end += 1;
      let fresh = 0;
      for (let k = i; k < end; k += 1) if (isNew[k]) fresh += 1;
      if (end - i >= PROSE_THRESHOLD && fresh > 0) inFlaggedRuns += end - i;
      else isolatedNew += fresh;
      i = end;
    }
  }

  return {
    count: inFlaggedRuns + isolatedNew,
    flagged: inFlaggedRuns > 0 || isolatedNew >= PROSE_THRESHOLD,
  };
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

  // A single-line comment ("// increment the counter") almost always states
  // a bare fact, not a rationale — the acceptance case for this hook. Only a
  // block is treated as prose worth a reminder; the model still makes the
  // real judgment call, this just filters the overwhelmingly common one-liner
  // before it ever reaches that question.
  const verdict = judgeWrittenComments(toolInput, family, 'after-write');
  if (!verdict.flagged) return null;

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
    count: verdict.count,
    marker: family.marker,
    hasTree,
  });

  dedup?.markAsSeen();
  return message;
}
