import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageVersion } from '@plebeiantech/lat.md-core/cli';
import { detectAgent } from './agent-detect.js';
import { readGitState } from './cli-tap.js';
import { usageEnabled } from './enabled.js';
import { applyParsedOutput, parseCommandOutput } from './output-parsers.js';
import { USAGE_SCHEMA_VERSION, type UsageEvent } from './schema.js';
import { writeUsageEvent } from './writer.js';

type ToolHandler = (...args: unknown[]) => unknown;

interface ToolOutcome {
  /** Byte length of the result text; null when the tool threw. */
  bytesOut: number | null;
  /** The result text, read for ids and never stored. */
  text: string | null;
  failed: boolean;
}

/** Tool argument holding the query; lat_expand takes its text instead. */
const QUERY_ARGUMENTS = ['query', 'text'];

function commandName(toolName: string): string {
  return toolName.replace(/^lat_/, '');
}

function toolQuery(handlerArgs: unknown[]): string | null {
  const args = handlerArgs[0];
  if (typeof args !== 'object' || args === null) return null;
  for (const key of QUERY_ARGUMENTS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function readOutcome(result: unknown): ToolOutcome {
  const { content, isError } = result as {
    content?: { type?: string; text?: unknown }[];
    isError?: boolean;
  };
  const text = (content ?? [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('');
  return {
    bytesOut: Buffer.byteLength(text, 'utf-8'),
    text,
    failed: isError === true,
  };
}

function buildEvent(
  toolName: string,
  query: string | null,
  root: string,
  start: number,
  outcome: ToolOutcome,
): UsageEvent {
  const command = commandName(toolName);
  const exitCode = outcome.failed ? 1 : 0;
  const { agent, sessionId } = detectAgent();
  const { head, worktree } = readGitState(root);
  const unknown_reasons: UsageEvent['unknown_reasons'] = {
    parent_session_id: 'not_captured',
    section_id: 'not_captured',
    found: 'not_captured',
    result_count: 'not_captured',
    bytes_out: 'not_captured',
  };
  if (agent.value === null) unknown_reasons.agent = agent.reason;
  if (sessionId.value === null) unknown_reasons.session_id = sessionId.reason;
  if (head === null) unknown_reasons.git_head = 'not_captured';
  if (worktree === null) unknown_reasons.worktree = 'not_captured';
  const event: UsageEvent = {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: randomUUID(),
    ts: new Date(start).toISOString(),
    duration_ms: Date.now() - start,
    command,
    surface: 'mcp',
    caller: agent.value ? 'agent' : 'human',
    agent: agent.value,
    lat_version: packageVersion(import.meta.url),
    session_id: sessionId.value,
    parent_session_id: null,
    repo_root: root,
    git_head: head,
    worktree,
    query,
    result_ids: [],
    result_count: null,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: exitCode,
    error_class: outcome.failed ? 'nonzero_exit' : null,
    unknown_reasons,
  };
  if (outcome.bytesOut !== null) {
    event.bytes_out = outcome.bytesOut;
    delete event.unknown_reasons.bytes_out;
  }
  if (outcome.text !== null) addParsedFields(event, command, outcome.text);
  return event;
}

/** Fills result ids, section id and found from the result text; never the text. */
function addParsedFields(
  event: UsageEvent,
  command: string,
  text: string,
): void {
  try {
    applyParsedOutput(
      event,
      parseCommandOutput(command, text, event.exit_code),
    );
  } catch {
    // The event keeps null with its reason for what the parser could not tell.
  }
}

function record(
  toolName: string,
  handlerArgs: unknown[],
  start: number,
  outcome: ToolOutcome,
  resolveRoot: () => string | null,
): void {
  try {
    const root = resolveRoot();
    if (root === null || !usageEnabled(root)) return;
    writeUsageEvent(
      root,
      buildEvent(toolName, toolQuery(handlerArgs), root, start, outcome),
    );
  } catch {
    return;
  }
}

function tapHandler(
  toolName: string,
  handler: ToolHandler,
  resolveRoot: () => string | null,
): ToolHandler {
  return async (...handlerArgs) => {
    const start = Date.now();
    let result: unknown;
    try {
      result = await handler(...handlerArgs);
    } catch (error) {
      record(
        toolName,
        handlerArgs,
        start,
        { bytesOut: null, text: null, failed: true },
        resolveRoot,
      );
      throw error;
    }
    try {
      record(toolName, handlerArgs, start, readOutcome(result), resolveRoot);
    } catch {
      // The result goes back untouched whatever the tap does.
    }
    return result;
  };
}

/**
 * Wraps the server's tool registration so every tool registered afterwards
 * records one usage event per call. Install it before the first server.tool.
 */
export function installMcpTap(
  server: McpServer,
  resolveRoot: () => string | null,
): void {
  const register = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as { tool: unknown }).tool = (...args: unknown[]) => {
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof args[0] !== 'string' || typeof handler !== 'function')
      return register(...args);
    return register(
      ...args.slice(0, handlerIndex),
      tapHandler(args[0], handler as ToolHandler, resolveRoot),
    );
  };
}
