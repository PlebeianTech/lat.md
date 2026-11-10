import { open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { reported, tokenCounters } from './token-counters.js';

interface RolloutLine {
  offset: number;
  record: Record<string, any>;
}

interface SessionIds {
  sessionId: string;
  parent: string | null;
}

interface RolloutHead {
  meta: Record<string, any>;
  timestamp: string;
}

const SINGLE_SLOT_KINDS = new Set([
  'session_start',
  'session_end',
  'session_name',
  'model',
  'token_usage',
]);

const HEAD_CHUNK_BYTES = 64 * 1024;
const HEAD_LIMIT_BYTES = 8 * 1024 * 1024;

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** The session_meta record on the first line, or null if it is not there yet. */
async function readHead(path: string): Promise<RolloutHead | null> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    for (;;) {
      const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        HEAD_CHUNK_BYTES,
        position,
      );
      if (bytesRead === 0) return null;
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
      if (position >= HEAD_LIMIT_BYTES) return null;
    }
    const record = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const meta = record?.payload;
    if (record?.type !== 'session_meta' || typeof meta?.id !== 'string')
      return null;
    return { meta, timestamp: String(record.timestamp ?? '') };
  } finally {
    await handle.close();
  }
}

async function rolloutsIn(dir: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 3)
      found.push(...(await rolloutsIn(path, depth + 1)));
    else if (
      entry.isFile() &&
      depth === 3 &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl')
    )
      found.push(path);
  }
  return found;
}

async function discover(repoRoot: string): Promise<string[]> {
  try {
    const roots = await worktreeRoots(repoRoot);
    const gitRoots = new Map<string, string>();
    const found: string[] = [];
    for (const path of await rolloutsIn(join(codexHome(), 'sessions'), 0)) {
      try {
        const cwd = (await readHead(path))?.meta.cwd;
        if (typeof cwd === 'string' && belongsToProject(roots, cwd, gitRoots))
          found.push(path);
      } catch {
        continue;
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
): { lines: RolloutLine[]; end: number } {
  const lines: RolloutLine[] = [];
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
        // A line that is not JSON carries nothing to report; skip it.
      }
    }
    local = newline + 1;
  }
  return { lines, end: base + local };
}

/** The thread name Codex keeps in session_index.jsonl, last entry winning. */
async function threadName(
  sessionPath: string,
  sessionId: string,
): Promise<{ name: string; updatedAt: string | null } | null> {
  const sessionsDir = dirname(dirname(dirname(dirname(sessionPath))));
  if (sessionsDir.split(sep).pop() !== 'sessions') return null;
  try {
    const text = await readFile(
      join(dirname(sessionsDir), 'session_index.jsonl'),
      'utf-8',
    );
    let found: { name: string; updatedAt: string | null } | null = null;
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.id === sessionId && typeof entry.thread_name === 'string')
          found = {
            name: entry.thread_name,
            updatedAt:
              typeof entry.updated_at === 'string' ? entry.updated_at : null,
          };
      } catch {
        continue;
      }
    }
    return found;
  } catch {
    return null;
  }
}

function shellScript(command: unknown): string | null {
  if (!Array.isArray(command) || !command.every((c) => typeof c === 'string'))
    return null;
  const [, flag, script] = command;
  return command.length === 3 && (flag === '-lc' || flag === '-c')
    ? script
    : command.join(' ');
}

function itemPath(location: string): string {
  return location.startsWith('file://') ? fileURLToPath(location) : location;
}

/** Codex reports an exit code on every finished command; -1 means none. */
function shellExitCode(exitCode: unknown): Captured<number> {
  return typeof exitCode === 'number' && exitCode >= 0
    ? { value: exitCode }
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
      return await readFrom(
        sessionPath,
        head,
        buffer.subarray(0, filled),
        start,
      );
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

async function readFrom(
  sessionPath: string,
  head: RolloutHead,
  buffer: Buffer,
  start: number,
): Promise<ReadResult> {
  const parsed = parseLines(buffer, start);
  const ids: SessionIds = {
    sessionId: head.meta.id,
    parent:
      typeof head.meta.parent_thread_id === 'string'
        ? head.meta.parent_thread_id
        : null,
  };
  const replayedBefore: number =
    typeof head.meta.subagent_history_start_ordinal === 'number'
      ? head.meta.subagent_history_start_ordinal
      : 0;
  const sessionCwd: string = head.meta.cwd ?? '/';
  const worktreeRoot = findWorktreeRoot(sessionCwd, new Map());
  const knowledgeDir = join(worktreeRoot, 'lat.md');

  const events: SessionEvent[] = [];
  const perOffset = new Map<number, number>();
  const seenResponses = new Set<string>();
  let lastModel: string | null = null;
  let turnCwd = sessionCwd;
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
      session_id: ids.sessionId,
      ts,
      source: { path: sessionPath, offset },
      ...(ids.parent ? { parent_session_id: ids.parent } : {}),
      ...payload,
    } as SessionEvent);
  };

  if (start === 0) push(0, head.timestamp, { kind: 'session_start' });

  for (const { offset, record } of parsed.lines) {
    if (record.type === 'session_meta' || record.ordinal < replayedBefore)
      continue;
    const ts: string = record.timestamp ?? lastTs ?? head.timestamp;
    lastTs = ts;
    lastOffset = offset;
    const payload = record.payload ?? {};

    if (record.type === 'turn_context') {
      if (typeof payload.cwd === 'string') turnCwd = payload.cwd;
      if (typeof payload.model === 'string' && payload.model !== lastModel) {
        lastModel = payload.model;
        push(offset, ts, { kind: 'model', model: payload.model });
      }
    } else if (record.type === 'token_usage_record') {
      const usage = payload.usage;
      if (!usage || seenResponses.has(payload.response_id)) continue;
      seenResponses.add(payload.response_id);
      const input = reported(usage.input_tokens);
      const cached = reported(usage.cached_input_tokens);
      const written = reported(usage.cache_write_input_tokens);
      push(offset, ts, {
        kind: 'token_usage',
        usage: tokenCounters({
          input:
            input === null || cached === null || written === null
              ? null
              : Math.max(0, input - cached - written),
          output: usage.output_tokens,
          cache_read: cached,
          cache_write: written,
          reasoning: usage.reasoning_output_tokens,
        }),
      });
    } else if (
      record.type === 'event_msg' &&
      payload.type === 'item_completed'
    ) {
      const item = payload.item ?? {};
      const emitTool = (tool: ToolCall) =>
        push(offset, ts, { kind: 'tool_call', tool });
      const relativePath = (file: string, cwd: string) =>
        toWorktreeRelativePath(resolve(cwd, file), worktreeRoot);

      if (item.type === 'FileChange' && item.status !== 'failed') {
        const bytes =
          typeof item.stdout === 'string'
            ? Buffer.byteLength(item.stdout)
            : null;
        for (const [file, change] of Object.entries<Record<string, any>>(
          item.changes ?? {},
        )) {
          const files =
            typeof change?.move_path === 'string'
              ? [file, change.move_path]
              : [file];
          for (const touched of files)
            emitTool({
              name: 'apply_patch',
              action: 'edit',
              path: relativePath(touched, turnCwd),
              bytes,
            });
        }
      } else if (item.type === 'ImageView' && typeof item.path === 'string') {
        emitTool({
          name: 'ImageView',
          action: 'read',
          path: relativePath(itemPath(item.path), turnCwd),
          bytes: null,
        });
      } else if (item.type === 'CommandExecution') {
        const script = shellScript(item.command);
        if (script === null) continue;
        const cwd = typeof item.cwd === 'string' ? itemPath(item.cwd) : turnCwd;
        const bytes =
          typeof item.aggregated_output === 'string'
            ? Buffer.byteLength(item.aggregated_output)
            : null;
        const exit = shellExitCode(item.exit_code);
        const segments = parseShell(script);
        emitTool({
          name: 'exec_command',
          action: 'shell',
          path: null,
          bytes,
          shell: { command: script, exit_code: exit },
        });
        // A failed or declined command with no exit code never ran, so it
        // read, wrote and closed nothing.
        if (
          exit.value === null &&
          (item.status === 'failed' || item.status === 'declined')
        )
          continue;
        for (const parsedCommand of item.parsed_cmd ?? []) {
          if (
            parsedCommand?.type === 'read' &&
            typeof parsedCommand.path === 'string'
          )
            emitTool({
              name: 'exec_command',
              action: 'read',
              path: relativePath(parsedCommand.path, cwd),
              bytes,
            });
          else if (parsedCommand?.type === 'search')
            emitTool({
              name: 'exec_command',
              action: 'search',
              path: null,
              bytes,
            });
        }
        for (const file of shellWritePaths(segments))
          emitTool({
            name: 'exec_command',
            action: 'edit',
            path: relativePath(file, cwd),
            bytes,
          });
        for (const arg of bypassReadArguments(segments))
          if (isInside(knowledgeDir, resolve(cwd, arg)))
            push(offset, ts, {
              kind: 'bypass_read',
              path: relativePath(arg, cwd),
              bytes,
            });
        if (exit.value === 0 || exit.value === null)
          for (const bd of bdCommands(segments))
            push(offset, ts, { kind: 'bd_command', ...bd });
      }
    }
  }

  if (lastOffset !== null && lastTs) {
    const name = await threadName(sessionPath, ids.sessionId);
    if (name)
      push(0, name.updatedAt ?? head.timestamp, {
        kind: 'session_name',
        name: name.name,
      });
    push(lastOffset, lastTs, { kind: 'session_end' });
  }

  return { events, checkpoint: { offset: parsed.end }, reason: null };
}

export const codexSource: SessionSource = { agent: 'codex', discover, read };
