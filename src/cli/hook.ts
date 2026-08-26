import { execSync } from 'node:child_process';
import { dirname, extname } from 'node:path';
import {
  findLatticeDir,
  loadAllSections,
  findSections,
  type Section,
} from '../lattice.js';
import { plainStyler, type CmdContext } from '../context.js';
import { expandPrompt } from './expand.js';
import { runSearch } from './search.js';
import { getSection, formatSectionOutput } from './section.js';
import { checkMd, checkCodeRefs, checkIndex, checkSections } from './check.js';
import { checkMode } from './check-mode.js';
import { SOURCE_EXTENSIONS } from '../source-parser.js';
import { federateTags, taggedDocsForFiles } from '../knowledge/index.js';
import {
  loadSessionMarkers,
  saveSessionMarkers,
} from '../knowledge/session.js';
import {
  computeCommentReminder,
  type PostToolUseInput,
} from './comment-reminder.js';
import { handlePreToolUse } from './comment-guard.js';

function outputPromptSubmit(context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    }),
  );
}

function outputPostToolUse(eventName: string, context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    }),
  );
}

/**
 * Cursor reads a flat `additional_context` field, where Claude and Codex read
 * a nested `hookSpecificOutput`. Same reminder, different envelope.
 */
function outputCursorPostToolUse(context: string): void {
  process.stdout.write(JSON.stringify({ additional_context: context }));
}

function outputStop(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
    }),
  );
}

function outputCursorStop(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      followup_message: reason,
    }),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function hasWikiLinks(text: string): boolean {
  return /\[\[[^\]]+\]\]/.test(text);
}

function makeHookCtx(latDir: string): CmdContext {
  return {
    latDir,
    projectRoot: dirname(latDir),
    styler: plainStyler,
    mode: 'cli',
  };
}

/**
 * Semantic-search enrichment, plus the files it matched. The file list is
 * returned rather than re-derived by a second `runSearch` call: the search is
 * the expensive part of this hook, and a second call would also have to
 * repeat the failure handling below — which, when it was missing, silently
 * dropped the caller's [[ref]] federation whenever the index was unusable.
 */
type SearchEnrichment = { text: string | null; filePaths: string[] };

async function searchAndExpand(
  ctx: CmdContext,
  userPrompt: string,
  preloadedSections?: Section[],
): Promise<SearchEnrichment> {
  let result;
  try {
    // Read-only: search an existing index but never build/update it here. A fresh
    // repo's first prompt must not trigger a full local embed pass — that's what
    // `lat search` / `lat reindex` are for. Returns no matches until then.
    result = await runSearch(ctx.latDir, userPrompt, 5, undefined, {
      buildIndex: false,
      preloadedSections,
    });
  } catch {
    // No usable backend (e.g. reindex required, key rejected) — skip semantic
    // enrichment silently rather than blocking the user's prompt.
    return { text: null, filePaths: [] };
  }
  const filePaths = result.matches.map((m) => m.section.filePath);
  if (result.matches.length === 0) return { text: null, filePaths };

  const parts: string[] = [
    `Search results for the user prompt (${result.matches.length} matches):`,
    '',
  ];

  for (const match of result.matches) {
    const sectionResult = await getSection(ctx, match.section.id);
    if (sectionResult.kind === 'found') {
      parts.push(formatSectionOutput(ctx, sectionResult));
      parts.push('');
    }
  }

  return { text: parts.join('\n'), filePaths };
}

async function handleUserPromptSubmit(): Promise<void> {
  let userPrompt = '';
  let sessionId: string | undefined;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    userPrompt = input.user_prompt ?? input.prompt ?? '';
    sessionId = input.session_id;
  } catch {
    // If we can't parse stdin, still emit the reminder
  }

  const parts: string[] = [];

  parts.push(
    "Before starting work, run `lat search` with one or more queries describing the user's intent.",
    'ALWAYS do this, even when the task seems straightforward — search results may reveal critical design details, protocols, or constraints.',
    'Use `lat section` to read the full content of relevant matches.',
    'Do not read files, write code, or run commands until you have searched.',
    '',
    'Remember: `lat.md/` must stay in sync with meaningful codebase state. If you change behavior, architecture, tests, or planned work, update the relevant current-state sections and run `lat check` before finishing. Do not use `lat.md/` as a journal/changelog or add notes for insignificant details.',
  );

  const latDir = findLatticeDir();
  if (latDir && userPrompt) {
    const ctx = makeHookCtx(latDir);
    // Loaded once and threaded through expansion, search, and federation
    // below — each of those otherwise walks and parses the whole tree itself.
    const allSections: Section[] = await loadAllSections(latDir);

    // If the user prompt contains [[refs]], resolve them inline
    if (hasWikiLinks(userPrompt)) {
      try {
        const expanded = await expandPrompt(ctx, userPrompt, allSections);
        if (expanded) {
          parts.push(
            '',
            'Expanded user prompt with resolved [[refs]]:',
            expanded,
          );
        } else {
          parts.push(
            '',
            'NOTE: The user prompt contains [[refs]] but they could not be resolved. Ask the user to correct them.',
          );
        }
      } catch {
        parts.push(
          '',
          'NOTE: The user prompt contains [[refs]] but resolution failed. Run `lat expand` on the prompt text manually.',
        );
      }
    }

    // Search for relevant sections and include their full content
    let searchFilePaths: string[] = [];
    try {
      const searchContext = await searchAndExpand(ctx, userPrompt, allSections);
      searchFilePaths = searchContext.filePaths;
      if (searchContext.text) {
        parts.push('', searchContext.text);
      }
    } catch {
      // Search failed (no key, index error, etc.) — agent can search manually
    }

    // Federate tagged-document knowledge: documents named by [[refs]] in the
    // prompt, then documents behind the semantic search matches. Wrapped in
    // one try/catch, like every other enrichment above — a failing store
    // lookup must never fail the user's prompt.
    try {
      const filePaths: string[] = [];

      // [[refs]] resolution must work with no embedding index built, so it
      // reuses findSections (the same resolver expandPrompt uses) rather
      // than any semantic search path.
      const refTargets = [...userPrompt.matchAll(/\[\[([^\]]+)\]\]/g)].map(
        (m) => m[1],
      );
      if (refTargets.length > 0) {
        for (const target of refTargets) {
          const matches = findSections(allSections, target);
          if (matches.length > 0) {
            filePaths.push(matches[0].section.filePath);
          }
        }
      }

      // Reuses what searchAndExpand already matched. Searching again here
      // would double the cost of every prompt, and an unusable index makes
      // runSearch throw — which abandoned the [[ref]] paths collected above,
      // even though resolving those never touches the index at all.
      filePaths.push(...searchFilePaths);

      const docs = await taggedDocsForFiles(ctx.projectRoot, filePaths);
      const sessionMarkers = loadSessionMarkers(sessionId);
      const federated = await federateTags(docs, {
        projectRoot: ctx.projectRoot,
        seen: sessionMarkers.markers.seen,
        attemptedEmpty: sessionMarkers.markers.attemptedEmpty,
      });
      saveSessionMarkers(sessionMarkers);
      if (federated) {
        parts.push('', federated);
      }
    } catch {
      // No stores available, no tagged docs, etc. — skip federation silently.
    }
  }

  outputPromptSubmit(parts.join('\n'));
}

/**
 * Reminds the agent of the `// @lat:` convention when it writes a comment
 * into code via Edit/Write. See `computeCommentReminder` for the rules.
 * Deliberately a reminder, not a gate: any failure here (bad stdin, fs
 * errors) is swallowed and simply produces no output — it must never fail
 * the edit that triggered it.
 */
async function handlePostToolUse(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as PostToolUseInput;
    const eventName = input.hook_event_name ?? 'PostToolUse';
    const toolName = input.tool_name ?? '';
    if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) return;

    const context = computeCommentReminder(input);
    if (context) outputPostToolUse(eventName, context);
  } catch {
    // Never fail the tool call over a malformed payload or an fs error.
  }
}

/**
 * Cursor's postToolUse payload names things differently from Claude's: the
 * path and content sit at the top level of `tool_input` under keys Cursor
 * chooses, and the tool is `Write` rather than `Edit`/`Write`/`MultiEdit`.
 * Normalize onto the shape `computeCommentReminder` already understands
 * rather than teaching that function a second dialect.
 */
async function handleCursorPostToolUse(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as {
      tool_name?: string;
      conversation_id?: string;
      cwd?: string;
      tool_input?: Record<string, unknown>;
    };
    if (!/^(Write|Edit|MultiEdit)$/i.test(input.tool_name ?? '')) return;

    const ti = input.tool_input ?? {};
    const filePath = (ti['file_path'] ?? ti['path'] ?? ti['target_file']) as
      | string
      | undefined;
    if (!filePath) return;
    const content = (ti['content'] ?? ti['contents'] ?? ti['new_string']) as
      | string
      | undefined;

    const context = computeCommentReminder({
      hook_event_name: 'postToolUse',
      session_id: input.conversation_id,
      cwd: input.cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: filePath,
        ...(content === undefined ? {} : { content }),
        ...(Array.isArray(ti['edits'])
          ? { edits: ti['edits'] as { new_string?: string }[] }
          : {}),
      },
    });
    if (context) outputCursorPostToolUse(context);
  } catch {
    // Never fail the tool call over a malformed payload or an fs error.
  }
}

/** Minimum diff size (in lines) to consider "significant" code change. */
/** Minimum code change size (lines) before we consider flagging lat.md/ sync. */
const DIFF_THRESHOLD = 5;

/** lat.md/ changes below this ratio of code changes trigger a sync reminder. */
const LATMD_RATIO = 0.05;

/** If lat.md/ changes exceed this many lines, skip the ratio check entirely. */
const LATMD_UPPER_THRESHOLD = 50;

/** Run `git diff --numstat` and return { codeLines, latMdLines }. */
function analyzeDiff(projectRoot: string): {
  codeLines: number;
  latMdLines: number;
} {
  let output: string;
  try {
    output = execSync('git diff HEAD --numstat', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 2000,
    });
  } catch {
    return { codeLines: 0, latMdLines: 0 };
  }

  let codeLines = 0;
  let latMdLines = 0;

  // Each line: "added\tremoved\tfile" (e.g. "42\t11\tsrc/cli/hook.ts")
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parseInt(parts[0], 10) || 0;
    const removed = parseInt(parts[1], 10) || 0;
    const file = parts[2];
    const changed = added + removed;
    if (file.startsWith('lat.md/')) {
      latMdLines += changed;
    } else if (SOURCE_EXTENSIONS.has(extname(file))) {
      codeLines += changed;
    }
  }

  return { codeLines, latMdLines };
}

type StopStatus = {
  checkFailed: boolean;
  totalErrors: number;
  needsSync: boolean;
  codeLines: number;
  latMdLines: number;
};

async function getStopStatus(latDir: string): Promise<StopStatus> {
  const md = await checkMd(latDir);
  const code = await checkCodeRefs(latDir);
  const indexErrors = await checkIndex(latDir);
  const sectionErrors = await checkSections(latDir);
  // Must stay in step with `checkAllCommand` in check.ts. A check counted
  // there but not here lets the Stop hook call a failing tree clean, which
  // silently disables the very enforcement the check was added for.
  const modeErrors = await checkMode(latDir);
  const totalErrors =
    md.errors.length +
    code.errors.length +
    indexErrors.length +
    sectionErrors.length +
    modeErrors.length;
  const checkFailed = totalErrors > 0;

  const projectRoot = dirname(latDir);
  const { codeLines, latMdLines } = analyzeDiff(projectRoot);
  let needsSync = false;
  if (codeLines >= DIFF_THRESHOLD && latMdLines < LATMD_UPPER_THRESHOLD) {
    const effectiveLatMd = latMdLines === 0 ? 0 : Math.max(latMdLines, 1);
    needsSync = effectiveLatMd < codeLines * LATMD_RATIO;
  }

  return {
    checkFailed,
    totalErrors,
    needsSync,
    codeLines,
    latMdLines,
  };
}

function formatStopReason({
  checkFailed,
  totalErrors,
  needsSync,
  codeLines,
  latMdLines,
}: StopStatus): string | null {
  if (!checkFailed && !needsSync) return null;

  const parts: string[] = [];

  const syncMsg =
    latMdLines === 0
      ? 'The codebase has changes (' +
        codeLines +
        ' lines) but `lat.md/` was not updated.'
      : 'The codebase has changes (' +
        codeLines +
        ' lines) but `lat.md/` may not be fully in sync (' +
        latMdLines +
        ' lines changed).';

  if (checkFailed && needsSync) {
    parts.push(
      '`lat check` found errors. ' + syncMsg + ' Before finishing:',
      '',
      '1. Update `lat.md/` where changes affect behavior, architecture, tests, or plans; keep it focused on current state rather than journal/changelog notes.',
      '2. Run `lat check` until it passes.',
    );
  } else if (checkFailed) {
    parts.push(
      '`lat check` found ' +
        totalErrors +
        ' error(s). Run `lat check`, fix the errors, and repeat until it passes.',
    );
  } else {
    parts.push(
      syncMsg +
        ' Review whether `lat.md/` needs a current-state update; do not add journal/changelog notes just to satisfy this reminder. Run `lat search` to find relevant sections and `lat check` at the end.',
    );
  }

  return parts.join('\n');
}

async function handleStop(): Promise<void> {
  const latDir = findLatticeDir();
  if (!latDir) return;

  // Read stdin to check if we already blocked once
  let stopHookActive = false;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    stopHookActive = input.stop_hook_active ?? false;
  } catch {
    // If we can't parse stdin, treat as first attempt
  }

  const status = await getStopStatus(latDir);

  // Second pass — warn the user but don't block again
  if (stopHookActive) {
    if (status.checkFailed) {
      console.error(
        `lat check is still failing (${status.totalErrors} error(s)). Run \`lat check\` to see details.`,
      );
    }
    return;
  }

  const reason = formatStopReason(status);
  if (!reason) return;
  outputStop(reason);
}

async function handleCursorStop(): Promise<void> {
  const latDir = findLatticeDir();
  if (!latDir) return;

  const reason = formatStopReason(await getStopStatus(latDir));
  if (!reason) return;
  outputCursorStop(reason);
}

export async function hookCmd(agent: string, event: string): Promise<void> {
  switch (agent) {
    case 'claude':
      switch (event) {
        case 'UserPromptSubmit':
          await handleUserPromptSubmit();
          return;
        case 'Stop':
          await handleStop();
          return;
        case 'PreToolUse':
          await handlePreToolUse(readStdin);
          return;
        case 'PostToolUse':
          await handlePostToolUse();
          return;
        default:
          console.error(
            `Unknown hook event for claude: ${event}. Supported: UserPromptSubmit, PreToolUse, Stop, PostToolUse`,
          );
          process.exit(1);
      }
    case 'codex':
      switch (event) {
        case 'UserPromptSubmit':
          await handleUserPromptSubmit();
          return;
        case 'Stop':
          await handleStop();
          return;
        case 'PostToolUse':
          await handlePostToolUse();
          return;
        default:
          console.error(
            `Unknown hook event for codex: ${event}. Supported: UserPromptSubmit, Stop, PostToolUse`,
          );
          process.exit(1);
      }
    case 'cursor':
      switch (event) {
        case 'stop':
          await handleCursorStop();
          return;
        case 'postToolUse':
          await handleCursorPostToolUse();
          return;
        default:
          console.error(
            `Unknown hook event for cursor: ${event}. Supported: stop, postToolUse`,
          );
          process.exit(1);
      }
    default:
      console.error(
        `Unknown agent: ${agent}. Supported: claude, codex, cursor`,
      );
      process.exit(1);
  }
}
