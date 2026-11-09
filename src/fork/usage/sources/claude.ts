import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  sessionEventId,
  toWorktreeRelativePath,
  type Captured,
  type SessionEvent,
  type ToolCall,
} from '../schema.js';
import {
  bdCommands,
  bypassReadArguments,
  isInside,
  parseShell,
  shellWritePaths,
} from './shell-parse.js';
import type { Checkpoint, ReadResult, SessionSource } from './types.js';
import {
  belongsToProject,
  findWorktreeRoot,
  worktreeRoots,
} from './worktrees.js';
import { tokenCounters } from './token-counters.js';

interface TranscriptLine {
  offset: number;
  record: Record<string, any>;
}

interface ToolResult {
  text: string;
  isError: boolean;
}

interface SessionIds {
  sessionId: string;
  parent: string | null;
}

const SINGLE_SLOT_KINDS = new Set([
  'session_start',
  'session_end',
  'session_name',
  'model',
  'token_usage',
]);

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

async function transcriptsIn(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(join(projectDir, entry.name));
    } else if (entry.isDirectory()) {
      const subagentDir = join(projectDir, entry.name, 'subagents');
      try {
        for (const name of await readdir(subagentDir)) {
          if (name.endsWith('.jsonl')) found.push(join(subagentDir, name));
        }
      } catch {
        continue;
      }
    }
  }
  return found;
}

// Bytes read from a transcript's head when looking for its cwd.
const CWD_SCAN_BYTES = 1024 * 1024;

/**
 * The first cwd a transcript records, or null when its head has none. Closing
 * readline does not close its input, so the stream is destroyed to free the fd.
 */
async function firstCwd(path: string): Promise<string | null> {
  const input = createReadStream(path, { end: CWD_SCAN_BYTES - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const cwd = JSON.parse(line)?.cwd;
        if (typeof cwd === 'string') return cwd;
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

async function discover(repoRoot: string): Promise<string[]> {
  try {
    const projectsDir = join(claudeConfigDir(), 'projects');
    const roots = await worktreeRoots(repoRoot);
    const gitRoots = new Map<string, string>();
    const found: string[] = [];
    // The slug maps every non-alphanumeric character to `-`, so /x/my-app and
    // /x/my.app share a directory. A transcript's own cwd decides.
    for (const root of roots) {
      for (const path of await transcriptsIn(
        join(projectsDir, projectSlug(root)),
      )) {
        try {
          const cwd = await firstCwd(path);
          if (cwd === null || belongsToProject(roots, cwd, gitRoots))
            found.push(path);
        } catch {
          continue;
        }
      }
    }
    return [...new Set(found)].sort();
  } catch {
    return [];
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  return '';
}

function shellExitCode(
  result: ToolResult | undefined,
  background: boolean,
): Captured<number> {
  if (!result || background) return { value: null, reason: 'not_captured' };
  if (!result.isError) return { value: 0 };
  const match = /^Exit code (\d+)/.exec(result.text);
  return match
    ? { value: Number(match[1]) }
    : { value: null, reason: 'not_captured' };
}

function isRealUserMessage(record: Record<string, any>): boolean {
  if (record.type !== 'user') return false;
  const content = record.message?.content;
  if (typeof content === 'string') return true;
  return (
    Array.isArray(content) && content.some((part) => part?.type === 'text')
  );
}

function toolUses(record: Record<string, any>): Record<string, any>[] {
  if (record.type !== 'assistant') return [];
  const content = record.message?.content;
  return Array.isArray(content)
    ? content.filter((part) => part?.type === 'tool_use')
    : [];
}

function parseLines(
  buffer: Buffer,
  base: number,
): { lines: TranscriptLine[]; end: number } {
  const lines: TranscriptLine[] = [];
  let local = 0;
  while (local < buffer.length) {
    const newline = buffer.indexOf(0x0a, local);
    if (newline === -1) break;
    const text = buffer.toString('utf-8', local, newline).trim();
    if (text) {
      try {
        const record = JSON.parse(text);
        if (record && typeof record === 'object')
          lines.push({ offset: base + local, record });
      } catch {
        local = newline + 1;
        continue;
      }
    }
    local = newline + 1;
  }
  return { lines, end: base + local };
}

function isClosingLine(record: Record<string, any>): boolean {
  return record.type === 'user' || record.type === 'system';
}

function firstOpenMessageGroup(lines: TranscriptLine[]): TranscriptLine | null {
  let last = -1;
  lines.forEach((line, index) => {
    if (line.record.type === 'assistant' && line.record.message?.id)
      last = index;
  });
  if (last === -1 || lines.slice(last + 1).some((l) => isClosingLine(l.record)))
    return null;
  const id = lines[last].record.message.id;
  return (
    lines.find(
      (l) => l.record.type === 'assistant' && l.record.message?.id === id,
    ) ?? null
  );
}

function firstOpenToolCall(
  lines: TranscriptLine[],
  results: Map<string, ToolResult>,
): TranscriptLine | null {
  let lastUserIndex = -1;
  lines.forEach((line, index) => {
    if (isRealUserMessage(line.record)) lastUserIndex = index;
  });
  for (let index = lastUserIndex + 1; index < lines.length; index++) {
    if (toolUses(lines[index].record).some((use) => !results.has(use.id)))
      return lines[index];
  }
  return null;
}

async function read(
  sessionPath: string,
  checkpoint: Checkpoint | null,
): Promise<ReadResult> {
  const unchanged: Checkpoint = checkpoint ?? { offset: 0 };
  try {
    const handle = await open(sessionPath, 'r');
    try {
      const { size } = await handle.stat();
      const start =
        checkpoint && checkpoint.offset <= size ? checkpoint.offset : 0;
      const buffer = Buffer.alloc(size - start);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.length - filled,
          start + filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return readFrom(sessionPath, buffer.subarray(0, filled), start);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      events: [],
      checkpoint: unchanged,
      reason: missing ? 'transcript_expired' : 'not_captured',
    };
  }
}

function readFrom(
  sessionPath: string,
  buffer: Buffer,
  start: number,
): ReadResult {
  const parsed = parseLines(buffer, start);
  const results = new Map<string, ToolResult>();
  for (const { record } of parsed.lines) {
    const content = record.message?.content;
    if (record.type !== 'user' || !Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_result')
        results.set(part.tool_use_id, {
          text: resultText(part.content),
          isError: part.is_error === true,
        });
    }
  }

  const earliestHold = Math.min(
    firstOpenToolCall(parsed.lines, results)?.offset ?? parsed.end,
    firstOpenMessageGroup(parsed.lines)?.offset ?? parsed.end,
  );
  const holdLine = parsed.lines.find((l) => l.offset === earliestHold);
  const holdMessageId =
    holdLine?.record.type === 'assistant' ? holdLine.record.message?.id : null;
  const holdOffset = holdMessageId
    ? (parsed.lines.find(
        (l) =>
          l.record.type === 'assistant' &&
          l.record.message?.id === holdMessageId,
      )?.offset ?? earliestHold)
    : earliestHold;
  const lines = parsed.lines.filter((line) => line.offset < holdOffset);
  const checkpointOffset = holdOffset;

  const events: SessionEvent[] = [];
  const perOffset = new Map<number, number>();
  const rootCache = new Map<string, string>();
  const seenMessages = new Set<string>();
  let lastModel: string | null = null;
  let lastTitle: string | null = null;
  let lastTs: string | null = null;
  let lastOffset: number | null = null;
  let lastIds: SessionIds | null = null;
  let cwd = '';

  const push = (
    offset: number,
    ts: string,
    ids: SessionIds,
    payload: Record<string, unknown>,
  ) => {
    const slot = SINGLE_SLOT_KINDS.has(payload.kind as string)
      ? String(payload.kind)
      : String(perOffset.get(offset) ?? 0);
    if (!SINGLE_SLOT_KINDS.has(payload.kind as string))
      perOffset.set(offset, Number(slot) + 1);
    events.push({
      event_id: sessionEventId(
        slot === '0' ? sessionPath : `${sessionPath}#${slot}`,
        offset,
      ),
      session_id: ids.sessionId,
      ts,
      source: { path: sessionPath, offset },
      ...(ids.parent ? { parent_session_id: ids.parent } : {}),
      ...payload,
    } as SessionEvent);
  };

  for (const { offset, record } of lines) {
    if (typeof record.cwd === 'string') cwd = record.cwd;
    if (typeof record.timestamp === 'string') lastTs = record.timestamp;
    const transcriptSession: string | undefined = record.sessionId;
    if (!transcriptSession) continue;
    const ids: SessionIds = record.agentId
      ? { sessionId: `agent-${record.agentId}`, parent: transcriptSession }
      : { sessionId: transcriptSession, parent: null };
    const ts = lastTs ?? new Date(0).toISOString();

    if (lastIds === null && start === 0)
      push(offset, ts, ids, { kind: 'session_start' });
    lastIds = ids;
    if (typeof record.timestamp === 'string') lastOffset = offset;

    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      if (record.aiTitle !== lastTitle) {
        lastTitle = record.aiTitle;
        push(offset, ts, ids, { kind: 'session_name', name: record.aiTitle });
      }
      continue;
    }
    if (record.type !== 'assistant') continue;

    const message = record.message ?? {};
    if (
      typeof message.model === 'string' &&
      message.model !== '<synthetic>' &&
      message.model !== lastModel
    ) {
      lastModel = message.model;
      push(offset, ts, ids, { kind: 'model', model: message.model });
    }
    if (message.usage && message.id && !seenMessages.has(message.id)) {
      seenMessages.add(message.id);
      const usage = message.usage;
      push(offset, ts, ids, {
        kind: 'token_usage',
        usage: tokenCounters({
          input: usage.input_tokens,
          output: usage.output_tokens,
          cache_read: usage.cache_read_input_tokens,
          cache_write: usage.cache_creation_input_tokens,
          reasoning: usage.output_tokens_details?.thinking_tokens,
        }),
      });
    }

    const worktreeRoot = findWorktreeRoot(cwd || '/', rootCache);
    const relativePath = (file: string) =>
      toWorktreeRelativePath(resolve(cwd, file), worktreeRoot);
    const knowledgeDir = join(worktreeRoot, 'lat.md');
    const targetsKnowledge = (file: string) =>
      isInside(knowledgeDir, resolve(cwd, file));

    for (const use of toolUses(record)) {
      const input = use.input ?? {};
      const result = results.get(use.id);
      const bytes = result ? Buffer.byteLength(result.text) : null;
      const emitTool = (tool: ToolCall) =>
        push(offset, ts, ids, { kind: 'tool_call', tool });
      const emitBypass = (file: string) =>
        push(offset, ts, ids, {
          kind: 'bypass_read',
          path: relativePath(file),
          bytes,
        });

      switch (use.name) {
        case 'Read': {
          const file = input.file_path;
          if (typeof file !== 'string') break;
          emitTool({
            name: use.name,
            action: 'read',
            path: relativePath(file),
            bytes,
          });
          if (targetsKnowledge(file)) emitBypass(file);
          break;
        }
        case 'Edit':
        case 'Write':
        case 'MultiEdit':
        case 'NotebookEdit': {
          const file = input.file_path ?? input.notebook_path;
          if (typeof file !== 'string') break;
          emitTool({
            name: use.name,
            action: 'edit',
            path: relativePath(file),
            bytes,
          });
          break;
        }
        case 'Grep':
        case 'Glob': {
          const target = typeof input.path === 'string' ? input.path : null;
          emitTool({
            name: use.name,
            action: 'search',
            path: target === null ? null : relativePath(target),
            bytes,
          });
          if (target !== null && targetsKnowledge(target)) emitBypass(target);
          break;
        }
        case 'Bash': {
          const command = input.command;
          if (typeof command !== 'string') break;
          const segments = parseShell(command);
          const exit = shellExitCode(result, input.run_in_background === true);
          emitTool({
            name: use.name,
            action: 'shell',
            path: null,
            bytes,
            shell: { command, exit_code: exit },
          });
          for (const file of shellWritePaths(segments))
            emitTool({
              name: use.name,
              action: 'edit',
              path: relativePath(file),
              bytes,
            });
          for (const arg of bypassReadArguments(segments))
            if (targetsKnowledge(arg)) emitBypass(arg);
          if (exit.value === 0 || exit.value === null)
            for (const bd of bdCommands(segments))
              push(offset, ts, ids, { kind: 'bd_command', ...bd });
          break;
        }
      }
    }
  }

  if (lastIds && lastOffset !== null && lastTs)
    push(lastOffset, lastTs, lastIds, { kind: 'session_end' });

  return { events, checkpoint: { offset: checkpointOffset }, reason: null };
}

export const claudeSource: SessionSource = { agent: 'claude', discover, read };
