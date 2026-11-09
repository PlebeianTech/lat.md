import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
import {
  belongsToProject,
  findWorktreeRoot,
  worktreeRoots,
} from './worktrees.js';
import type { Checkpoint, ReadResult, SessionSource } from './types.js';
import { reportedTotal, tokenCounters } from './token-counters.js';

interface SessionLine {
  offset: number;
  record: Record<string, any>;
}

interface ToolResult {
  text: string;
  isError: boolean;
}

interface SessionHead {
  id: string;
  cwd: string;
  timestamp: string;
}

const SINGLE_SLOT_KINDS = new Set([
  'session_start',
  'session_end',
  'session_name',
  'model',
  'token_usage',
]);

const HEAD_BYTES = 64 * 1024;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

async function readHead(path: string): Promise<SessionHead | null> {
  const handle = await open(path, 'r');
  try {
    const chunk = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, HEAD_BYTES, 0);
    const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (newline === -1) return null;
    const record = JSON.parse(chunk.toString('utf-8', 0, newline));
    if (
      record?.type !== 'session' ||
      typeof record.id !== 'string' ||
      typeof record.cwd !== 'string'
    )
      return null;
    return {
      id: record.id,
      cwd: record.cwd,
      timestamp: String(record.timestamp ?? ''),
    };
  } finally {
    await handle.close();
  }
}

async function discover(repoRoot: string): Promise<string[]> {
  try {
    const roots = await worktreeRoots(repoRoot);
    const gitRoots = new Map<string, string>();
    const sessionsDir = join(agentDir(), 'sessions');
    const found: string[] = [];
    for (const slug of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const slugDir = join(sessionsDir, slug.name);
      for (const entry of await readdir(slugDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const path = join(slugDir, entry.name);
        try {
          const cwd = (await readHead(path))?.cwd;
          if (cwd && belongsToProject(roots, cwd, gitRoots)) found.push(path);
        } catch {
          continue;
        }
      }
    }
    return found.sort();
  } catch {
    return [];
  }
}

function parseLines(
  buffer: Buffer,
  base: number,
): { lines: SessionLine[]; end: number } {
  const lines: SessionLine[] = [];
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

function toolCallsOf(record: Record<string, any>): Record<string, any>[] {
  const content = record.message?.content;
  if (record.type !== 'message' || record.message?.role !== 'assistant')
    return [];
  return Array.isArray(content)
    ? content.filter((part) => part?.type === 'toolCall')
    : [];
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function firstOpenTail(
  lines: SessionLine[],
  results: Map<string, ToolResult>,
): SessionLine | null {
  const turns = lines.filter(
    (l) =>
      l.record.type === 'message' &&
      (l.record.message?.role === 'assistant' ||
        l.record.message?.role === 'user'),
  );
  const tail = turns[turns.length - 1];
  if (!tail) return null;
  return toolCallsOf(tail.record).some((call) => !results.has(call.id))
    ? tail
    : null;
}

function shellExitCode(result: ToolResult | undefined): Captured<number> {
  if (!result) return { value: null, reason: 'not_captured' };
  if (!result.isError) return { value: 0 };
  const failed = /Command exited with code (\d+)\s*$/.exec(result.text);
  return failed
    ? { value: Number(failed[1]) }
    : { value: null, reason: 'not_captured' };
}

async function read(
  sessionPath: string,
  checkpoint: Checkpoint | null,
): Promise<ReadResult> {
  const unchanged: Checkpoint = checkpoint ?? { offset: 0 };
  try {
    const head = await readHead(sessionPath);
    if (!head) return { events: [], checkpoint: unchanged, reason: null };
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
      return readFrom(sessionPath, head, buffer.subarray(0, filled), start);
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
  head: SessionHead,
  buffer: Buffer,
  start: number,
): ReadResult {
  const parsed = parseLines(buffer, start);
  const results = new Map<string, ToolResult>();
  for (const { record } of parsed.lines) {
    const message = record.message;
    if (record.type === 'message' && message?.role === 'toolResult')
      results.set(message.toolCallId, {
        text: resultText(message.content),
        isError: message.isError === true,
      });
  }

  const hold = firstOpenTail(parsed.lines, results);
  const lines = hold
    ? parsed.lines.filter((l) => l.offset < hold.offset)
    : parsed.lines;
  const checkpointOffset = hold ? hold.offset : parsed.end;

  const worktreeRoot = findWorktreeRoot(head.cwd, new Map());
  const knowledgeDir = join(worktreeRoot, 'lat.md');
  const relativePath = (file: string) =>
    toWorktreeRelativePath(resolve(head.cwd, file), worktreeRoot);
  const targetsKnowledge = (file: string) =>
    isInside(knowledgeDir, resolve(head.cwd, file));

  const events: SessionEvent[] = [];
  const perOffset = new Map<number, number>();
  let lastModel: string | null = null;
  let lastName: string | null = null;
  let lastTs: string | null = null;
  let lastOffset: number | null = null;

  const push = (
    offset: number,
    ts: string,
    payload: Record<string, unknown>,
  ) => {
    const single = SINGLE_SLOT_KINDS.has(payload.kind as string);
    const slot = single
      ? String(payload.kind)
      : String(perOffset.get(offset) ?? 0);
    if (!single) perOffset.set(offset, Number(slot) + 1);
    events.push({
      event_id: sessionEventId(
        slot === '0' ? sessionPath : `${sessionPath}#${slot}`,
        offset,
      ),
      session_id: head.id,
      ts,
      source: { path: sessionPath, offset },
      ...payload,
    } as SessionEvent);
  };

  const pushModel = (offset: number, ts: string, model: unknown) => {
    if (typeof model !== 'string' || model === lastModel) return;
    lastModel = model;
    push(offset, ts, { kind: 'model', model });
  };

  const pushUsage = (offset: number, ts: string, usage: any) => {
    const counters = tokenCounters({
      input: usage?.input,
      output: usage?.output,
      cache_read: usage?.cacheRead,
      cache_write: usage?.cacheWrite,
      reasoning: usage?.reasoning,
    });
    if (reportedTotal(counters) === 0) return;
    push(offset, ts, {
      kind: 'token_usage',
      usage: {
        ...counters,
        ...(typeof usage.cost?.total === 'number'
          ? { reported_cost_usd: usage.cost.total }
          : {}),
      },
    });
  };

  if (start === 0) push(0, head.timestamp, { kind: 'session_start' });

  for (const { offset, record } of lines) {
    const ts: string = record.timestamp ?? lastTs ?? head.timestamp;
    lastTs = ts;
    lastOffset = offset;

    if (record.type === 'model_change') {
      pushModel(offset, ts, record.modelId);
    } else if (record.type === 'session_info') {
      if (typeof record.name === 'string' && record.name !== lastName) {
        lastName = record.name;
        push(offset, ts, { kind: 'session_name', name: record.name });
      }
    } else if (record.type === 'compaction') {
      pushUsage(offset, ts, record.usage);
    } else if (
      record.type === 'message' &&
      record.message?.role === 'assistant'
    ) {
      pushModel(offset, ts, record.message.model);
      pushUsage(offset, ts, record.message.usage);
      for (const call of toolCallsOf(record)) {
        const args = call.arguments ?? {};
        const result = results.get(call.id);
        const bytes = result ? Buffer.byteLength(result.text) : null;
        const emitTool = (tool: ToolCall) =>
          push(offset, ts, { kind: 'tool_call', tool });
        const emitBypass = (file: string) =>
          push(offset, ts, {
            kind: 'bypass_read',
            path: relativePath(file),
            bytes,
          });

        if (call.name === 'read' && typeof args.path === 'string') {
          emitTool({
            name: call.name,
            action: 'read',
            path: relativePath(args.path),
            bytes,
          });
          if (targetsKnowledge(args.path)) emitBypass(args.path);
        } else if (
          (call.name === 'edit' || call.name === 'write') &&
          typeof args.path === 'string'
        ) {
          emitTool({
            name: call.name,
            action: 'edit',
            path: relativePath(args.path),
            bytes,
          });
        } else if (
          call.name === 'grep' ||
          call.name === 'find' ||
          call.name === 'ls'
        ) {
          const target = typeof args.path === 'string' ? args.path : null;
          emitTool({
            name: call.name,
            action: 'search',
            path: target === null ? null : relativePath(target),
            bytes,
          });
          if (call.name !== 'ls' && target !== null && targetsKnowledge(target))
            emitBypass(target);
        } else if (call.name === 'bash') {
          const command = args.command ?? args.cmd;
          if (typeof command !== 'string') continue;
          const segments = parseShell(command);
          const exit = shellExitCode(result);
          emitTool({
            name: call.name,
            action: 'shell',
            path: null,
            bytes,
            shell: { command, exit_code: exit },
          });
          for (const file of shellWritePaths(segments))
            emitTool({
              name: call.name,
              action: 'edit',
              path: relativePath(file),
              bytes,
            });
          for (const arg of bypassReadArguments(segments))
            if (targetsKnowledge(arg)) emitBypass(arg);
          if (exit.value === 0 || exit.value === null)
            for (const bd of bdCommands(segments))
              push(offset, ts, { kind: 'bd_command', ...bd });
        }
      }
    }
  }

  if (lastOffset !== null && lastTs)
    push(lastOffset, lastTs, { kind: 'session_end' });

  return { events, checkpoint: { offset: checkpointOffset }, reason: null };
}

export const piSource: SessionSource = { agent: 'pi', discover, read };
