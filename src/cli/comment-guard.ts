import {
  candidateCommentLines,
  extractWrittenText,
  hasLatTree,
  matchFamily,
  resolveProjectRoot,
  type ToolInput,
} from './comment-reminder.js';

/**
 * The blocking half of the comment convention. `computeCommentReminder` runs
 * at PostToolUse and only advises: by then the prose is already on disk, and
 * it is deduped to once per file per session, so the second rationale block
 * in a file draws no signal at all.
 *
 * This runs at PreToolUse instead, where `tool_input` is visible before the
 * edit is applied and the hook can answer `deny`. A multi-line comment is
 * refused outright and the agent is told to put the reasoning in `lat.md/`
 * and leave a `@lat:` pointer behind.
 *
 * There is deliberately no per-session dedup here. A gate that fires once is
 * not a gate.
 */

/** Minimum candidate comment lines in one write before the edit is refused.
 *  A single line ("// bytes, not chars") is the bare-fact case the convention
 *  explicitly allows; two or more is a block of prose. */
const BLOCK_THRESHOLD = 2;

/** Explicit, reviewable opt-out. Spelled the same as the `lat:ignore` token
 *  [[src/code-refs.ts]] already honours, so a project has one escape hatch to
 *  learn rather than two. It suppresses only the line it appears on, which
 *  keeps a deliberate exception visible in the diff instead of silently
 *  disarming the gate for a whole file. */
const LAT_IGNORE_RE = /(?<![\w])lat:ignore(?![-\w])/;

export type PreToolUseInput = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: ToolInput;
};

function buildReason(opts: {
  base: string;
  count: number;
  marker: string;
  hasTree: boolean;
}): string {
  const where = opts.hasTree
    ? '  1. Put the reasoning in a lat.md/ section. Verbatim is fine — it does\n' +
      '     not need rewriting. Use `lat search` / `lat locate` to find where it\n' +
      '     belongs; create a new section only if nothing existing fits.'
    : '  1. This project has no lat.md/ tree yet. Run `lat init` to create one\n' +
      '     (or create lat.md/ by hand), then put the reasoning in a section there.';

  return (
    `Blocked by the lat.md comment convention: this edit writes ${opts.count} ` +
    `comment lines into ${opts.base}.\n\n` +
    'A code comment states a bare fact only — a unit, a bound, what null means, ' +
    'an issue id, or an `@lat:` pointer. A comment that explains WHY (a reason, ' +
    'a trade-off, a rejected alternative, a constraint, or the rationale behind ' +
    'an invariant) is documentation, and documentation does not live in source.\n\n' +
    'Do this instead:\n' +
    `${where}\n` +
    '  2. Leave a pointer in the code where the prose was:\n' +
    `       ${opts.marker} @lat: [[section-id]]\n` +
    '  3. Re-apply the edit with the prose replaced by that one pointer line.\n\n' +
    'If a comment only narrates what the code does, delete it rather than ' +
    'moving it — a reader could reconstruct it from the code.\n\n' +
    `To keep a specific line anyway, put \`lat:ignore\` on it. That is an ` +
    'explicit, reviewable exception, not a way to silence the gate.'
  );
}

/**
 * Returns the denial reason for a single Edit/Write/MultiEdit call, or `null`
 * to let the edit through. Pure and synchronous: every fallible bit (fs, git)
 * is wrapped internally and degrades to "allow", never to a thrown error. A
 * gate that crashes must fail open — refusing every edit because `git` is
 * missing would be far worse than missing a comment.
 */
function outputDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

/**
 * PreToolUse entry point. Lives here rather than in `hook.ts` so the upstream
 * file carries only an import and a `case` — see the fork's upstream-divergence
 * constraint. `readStdin` is injected for the same reason: it is `hook.ts`'s
 * private helper and exporting it would widen that file's diff.
 */
export async function handlePreToolUse(
  readStdin: () => Promise<string>,
): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as PreToolUseInput;
    const toolName = input.tool_name ?? '';
    if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) return;

    const reason = computeCommentBlock(input);
    if (reason) outputDeny(reason);
  } catch {
    // Fail open: never block a tool call over a malformed payload or fs error.
  }
}

export function computeCommentBlock(input: PreToolUseInput): string | null {
  const toolInput = input.tool_input ?? {};
  const filePath = toolInput.file_path;
  if (!filePath) return null;

  // `FAMILIES` is the single place that decides which files are eligible, and
  // no family matches `.md` — markdown, where prose belongs, is never gated.
  const family = matchFamily(filePath);
  if (!family) return null;

  const written = extractWrittenText(toolInput);
  if (!written) return null;

  const candidates = candidateCommentLines(written, family).filter(
    (line) => !LAT_IGNORE_RE.test(line),
  );
  if (candidates.length < BLOCK_THRESHOLD) return null;

  const projectRoot = resolveProjectRoot(filePath, input.cwd);
  if (!projectRoot) return null;

  return buildReason({
    base: filePath.split('/').pop() ?? filePath,
    count: candidates.length,
    marker: family.marker,
    hasTree: hasLatTree(projectRoot),
  });
}
