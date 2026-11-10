/**
 * Parsers for the plain-text output of lat commands. Each takes the text a
 * command printed and returns ids, counts and flags, never the text itself.
 * The CLI tap uses them on captured stdout; the MCP tap reuses them because
 * the MCP tools return the same formats.
 */

import type { UsageEvent } from './schema.js';

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

const SEARCH_RESULT_LINE = /^\* (?:Section|File): \[\[([^\]]+)\]\]/;
const SECTION_FIRST_LINE = /^\[\[([^\]]+)\]\] \(/;
const EXPAND_REF_LINE = /^\* `\[\[/;
const EXPAND_MATCH_LINE = /^ {2}\* \[\[([^\]]+)\]\]/;
const HOOK_SEARCH_HEADING =
  /^Search results for the user prompt \(\d+ matches\):$/;
const HOOK_BULLET_LINE = /^\* \[\[([^\]]+)\]\]/;

/** Section and file ids from `lat search`, in printed rank order. */
export function parseSearchOutput(output: string): string[] {
  const ids: string[] = [];
  for (const line of stripAnsi(output).split('\n')) {
    const id = SEARCH_RESULT_LINE.exec(line)?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * The section id on the first line of `lat section` output. A failing command
 * that printed no section did not find one.
 */
export function parseSectionOutput(
  output: string,
  exitCode: number,
): { sectionId: string | null; found: boolean | null } {
  const firstLine = stripAnsi(output).split('\n', 1)[0];
  const sectionId = SECTION_FIRST_LINE.exec(firstLine)?.[1] ?? null;
  if (sectionId !== null) return { sectionId, found: true };
  return { sectionId: null, found: exitCode === 0 ? null : false };
}

/** The best match of each ref in the `lat expand` context block. */
export function parseExpandOutput(output: string): string[] {
  const text = stripAnsi(output);
  const start = text.lastIndexOf('<lat-context>\n');
  if (start === -1) return [];
  const ids: string[] = [];
  let awaitingBestMatch = false;
  for (const line of text.slice(start).split('\n')) {
    if (line === '</lat-context>') break;
    if (EXPAND_REF_LINE.test(line)) {
      awaitingBestMatch = true;
      continue;
    }
    const id = EXPAND_MATCH_LINE.exec(line)?.[1];
    if (awaitingBestMatch && id !== undefined) {
      ids.push(id);
      awaitingBestMatch = false;
    }
  }
  return ids;
}

export interface HookOutputFields {
  resultIds: string[] | null;
  sectionId: string | null;
  injectedBytes: number | null;
}

const UNKNOWN_HOOK_OUTPUT: HookOutputFields = {
  resultIds: null,
  sectionId: null,
  injectedBytes: null,
};

interface HookJson {
  hookSpecificOutput?: {
    additionalContext?: unknown;
    permissionDecisionReason?: unknown;
  };
  reason?: unknown;
  additional_context?: unknown;
  followup_message?: unknown;
  injectSteps?: unknown;
}

/**
 * Every text field of a hook's JSON output that reaches the agent: Claude and
 * Codex context and PreToolUse deny reasons, Stop `reason`, Cursor's
 * `additional_context` and `followup_message`, and Antigravity's
 * `injectSteps[].ephemeralMessage`.
 */
function injectedTexts(output: HookJson | null): string[] {
  const steps: Array<{ ephemeralMessage?: unknown } | null> = Array.isArray(
    output?.injectSteps,
  )
    ? output.injectSteps
    : [];
  return [
    output?.hookSpecificOutput?.additionalContext,
    output?.hookSpecificOutput?.permissionDecisionReason,
    output?.reason,
    output?.additional_context,
    output?.followup_message,
    ...steps.map((step) => step?.ephemeralMessage),
  ].filter((text): text is string => typeof text === 'string');
}

/**
 * The bytes a hook injected, summed over every text field the agent sees, and
 * the ids it injected for the user prompt. Ids come from `additionalContext`
 * only, from the bullets under the search results heading, so the Stop hook's
 * linked-sections list and the refs inside a full section body stay out. One
 * match prints its whole body, and then that section is also the section id.
 */
export function parseHookOutput(stdout: string): HookOutputFields {
  if (stdout.trim() === '') return { ...UNKNOWN_HOOK_OUTPUT, injectedBytes: 0 };
  let output: HookJson | null;
  try {
    output = JSON.parse(stdout);
  } catch {
    return UNKNOWN_HOOK_OUTPUT;
  }
  if (typeof output !== 'object' || output === null || Array.isArray(output))
    return UNKNOWN_HOOK_OUTPUT;
  const texts = injectedTexts(output);
  const injectedBytes = texts.reduce(
    (sum, text) => sum + Buffer.byteLength(text, 'utf-8'),
    0,
  );
  const additionalContext = output?.hookSpecificOutput?.additionalContext;
  if (typeof additionalContext !== 'string')
    return { ...UNKNOWN_HOOK_OUTPUT, injectedBytes };
  const lines = stripAnsi(additionalContext).split('\n');
  const heading = lines.findIndex((line) => HOOK_SEARCH_HEADING.test(line));
  if (heading === -1) return { ...UNKNOWN_HOOK_OUTPUT, injectedBytes };

  const rest = lines.slice(heading + 1);
  const afterHeading = rest[0] === '' ? rest.slice(1) : rest;
  const fullBodyId = SECTION_FIRST_LINE.exec(afterHeading[0] ?? '')?.[1];
  if (fullBodyId !== undefined)
    return { resultIds: [fullBodyId], sectionId: fullBodyId, injectedBytes };

  const resultIds: string[] = [];
  for (const line of afterHeading) {
    const id = HOOK_BULLET_LINE.exec(line)?.[1];
    if (id === undefined) break;
    resultIds.push(id);
  }
  return { resultIds, sectionId: null, injectedBytes };
}

export interface ParsedOutput {
  resultIds: string[] | null;
  sectionId: string | null;
  found: boolean | null;
  injectedBytes: number | null;
}

/** Parses the captured output of one command; null means the parser cannot tell. */
export function parseCommandOutput(
  command: string,
  output: string,
  exitCode: number,
): ParsedOutput {
  const none: ParsedOutput = {
    resultIds: null,
    sectionId: null,
    found: null,
    injectedBytes: null,
  };
  switch (command.split(' ')[0]) {
    case 'search':
      return exitCode === 0
        ? { ...none, resultIds: parseSearchOutput(output) }
        : none;
    case 'section':
      return { ...none, ...parseSectionOutput(output, exitCode) };
    case 'expand':
      return exitCode === 0
        ? { ...none, resultIds: parseExpandOutput(output) }
        : none;
    case 'hook':
      return exitCode === 0 ? { ...none, ...parseHookOutput(output) } : none;
    default:
      return none;
  }
}

/**
 * Copies what a parser could tell onto the event and drops the matching
 * unknown_reasons entries. Fields the parser could not tell keep their null
 * and their reason.
 */
export function applyParsedOutput(
  event: UsageEvent,
  parsed: ParsedOutput,
): void {
  // `lat search` with no or an empty query only rebuilds the index, so it has
  // no results.
  const ranSearch =
    event.command !== 'search' || (event.query !== null && event.query !== '');
  if (parsed.resultIds !== null && ranSearch) {
    event.result_ids = parsed.resultIds;
    event.result_count = parsed.resultIds.length;
    delete event.unknown_reasons.result_count;
  }
  if (parsed.sectionId !== null) event.section_id = parsed.sectionId;
  if (parsed.sectionId !== null || parsed.found === false)
    delete event.unknown_reasons.section_id;
  if (parsed.found !== null) {
    event.found = parsed.found;
    delete event.unknown_reasons.found;
  }
  if (parsed.injectedBytes !== null) {
    event.injected_bytes = parsed.injectedBytes;
    delete event.unknown_reasons.injected_bytes;
  }
}
