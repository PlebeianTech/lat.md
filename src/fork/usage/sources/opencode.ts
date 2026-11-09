import { existsSync } from 'node:fs';
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

// @lat: [[usage-source-opencode#Usage Source OpenCode#Session paths and the checkpoint cursor]]

type Row = Record<string, any>;
type Query = (sql: string, ...args: (string | number)[]) => Row[];

const PATH_SEPARATOR = '#';
const FIXED_SLOT_KINDS = new Set([
  'session_start',
  'session_name',
  'session_end',
]);
const PLACEHOLDER_TITLE = /^(New session|Child session) - /;
const EDIT_TOOLS = new Set(['edit', 'write']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);
const PATCH_FILE_LINE =
  /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function databasePath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

function sessionPathOf(database: string, sessionId: string): string {
  return `${database}${PATH_SEPARATOR}${sessionId}`;
}

function splitSessionPath(
  sessionPath: string,
): { database: string; sessionId: string } | null {
  const cut = sessionPath.lastIndexOf(PATH_SEPARATOR);
  return cut === -1
    ? null
    : {
        database: sessionPath.slice(0, cut),
        sessionId: sessionPath.slice(cut + 1),
      };
}

async function withDatabase<T>(
  database: string,
  work: (query: Query) => T,
): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite');
  const connection = new DatabaseSync(database, {
    readOnly: true,
    timeout: 2000,
  });
  try {
    return work(
      (sql, ...args) => connection.prepare(sql).all(...args) as Row[],
    );
  } finally {
    connection.close();
  }
}

function parseJson(text: unknown): Row {
  try {
    const value = JSON.parse(String(text));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function discover(repoRoot: string): Promise<string[]> {
  try {
    const database = databasePath();
    if (!existsSync(database)) return [];
    const roots = await worktreeRoots(repoRoot);
    const gitRoots = new Map<string, string>();
    const sessions = await withDatabase(database, (query) =>
      query('SELECT id, directory FROM session ORDER BY id'),
    );
    return sessions
      .filter((s) => belongsToProject(roots, String(s.directory), gitRoots))
      .map((s) => sessionPathOf(database, String(s.id)));
  } catch {
    return [];
  }
}

interface StoredMessage {
  id: string;
  created: number;
  data: Row;
  parts: Row[];
}

function loadMessages(
  query: Query,
  sessionId: string,
  from: number,
): StoredMessage[] {
  const messages = query(
    'SELECT id, time_created, data FROM message WHERE session_id = ? AND time_created >= ? ORDER BY time_created, id',
    sessionId,
    from,
  ).map((row) => ({
    id: String(row.id),
    created: Number(row.time_created),
    data: parseJson(row.data),
    parts: [] as Row[],
  }));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const parts = query(
    'SELECT p.message_id, p.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? AND m.time_created >= ? ORDER BY p.id',
    sessionId,
    from,
  );
  for (const part of parts)
    byId.get(String(part.message_id))?.parts.push(parseJson(part.data));
  return messages;
}

function isUnfinished(message: StoredMessage): boolean {
  return (
    message.data.role === 'assistant' &&
    message.data.time?.completed == null &&
    message.data.error == null
  );
}

function shellExitCode(state: Row): Captured<number> {
  const exit = state.metadata?.exit;
  return state.status === 'completed' && typeof exit === 'number'
    ? { value: exit }
    : { value: null, reason: 'not_captured' };
}

function patchPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') return [];
  return [...patchText.matchAll(PATCH_FILE_LINE)].map((m) => m[1].trim());
}

async function read(
  sessionPath: string,
  checkpoint: Checkpoint | null,
): Promise<ReadResult> {
  const unchanged: Checkpoint = checkpoint ?? { offset: 0 };
  const target = splitSessionPath(sessionPath);
  try {
    if (!target)
      return { events: [], checkpoint: unchanged, reason: 'not_captured' };
    const start = checkpoint ? checkpoint.offset : 0;
    const stored = await withDatabase(target.database, (query) => {
      const session = query(
        'SELECT id, parent_id, directory, title, time_created FROM session WHERE id = ?',
        target.sessionId,
      )[0];
      return {
        session,
        messages: session ? loadMessages(query, target.sessionId, start) : [],
      };
    });
    if (!stored.session)
      return { events: [], checkpoint: unchanged, reason: 'not_captured' };
    return readFrom(
      sessionPath,
      stored.session,
      stored.messages,
      start,
      checkpoint === null,
    );
  } catch {
    const gone = target !== null && !existsSync(target.database);
    return {
      events: [],
      checkpoint: unchanged,
      reason: gone ? 'transcript_expired' : 'not_captured',
    };
  }
}

function readFrom(
  sessionPath: string,
  session: Row,
  allMessages: StoredMessage[],
  start: number,
  firstRead: boolean,
): ReadResult {
  const directory = String(session.directory);
  const tail = allMessages.filter((m) => m.data.role === 'assistant').at(-1);
  const holdFrom = tail && isUnfinished(tail) ? tail.created : null;
  const messages =
    holdFrom === null
      ? allMessages
      : allMessages.filter((m) => m.created < holdFrom);
  const lastCreated = messages.at(-1)?.created;
  const checkpointOffset =
    holdFrom ?? (lastCreated === undefined ? start : lastCreated + 1);

  const worktreeRoot = findWorktreeRoot(directory, new Map());
  const knowledgeDir = join(worktreeRoot, 'lat.md');
  const parentId =
    typeof session.parent_id === 'string' && session.parent_id
      ? { parent_session_id: session.parent_id }
      : {};
  const sessionId = String(session.id);
  const iso = (ms: number) => new Date(ms).toISOString();

  const events: SessionEvent[] = [];
  const perKind = new Map<string, number>();
  let lastModel: string | null = null;

  const push = (
    offset: number,
    ts: string,
    payload: Record<string, unknown>,
  ) => {
    const kind = payload.kind as string;
    const key = `${offset}:${kind}`;
    const count = perKind.get(key) ?? 0;
    perKind.set(key, count + 1);
    const slot = FIXED_SLOT_KINDS.has(kind) ? kind : `${kind}#${count}`;
    events.push({
      event_id: sessionEventId(`${sessionPath}#${slot}`, offset),
      session_id: sessionId,
      ...parentId,
      ts,
      source: { path: sessionPath, offset },
      ...payload,
    } as SessionEvent);
  };

  const createdTs = iso(Number(session.time_created));
  if (firstRead) push(0, createdTs, { kind: 'session_start' });
  const title = String(session.title ?? '');
  if (
    title &&
    !PLACEHOLDER_TITLE.test(title) &&
    (firstRead || messages.length > 0)
  )
    push(0, createdTs, { kind: 'session_name', name: title });

  for (const message of messages) {
    if (message.data.role !== 'assistant') continue;
    const offset = message.created;
    const ts = iso(offset);
    const modelId = message.data.modelID;
    if (typeof modelId === 'string' && modelId !== lastModel) {
      lastModel = modelId;
      push(offset, ts, { kind: 'model', model: modelId });
    }

    const tokens = message.data.tokens ?? {};
    const counters = tokenCounters({
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cache?.read,
      cache_write: tokens.cache?.write,
      reasoning: tokens.reasoning,
    });
    if (reportedTotal(counters) > 0)
      push(offset, ts, {
        kind: 'token_usage',
        usage: {
          ...counters,
          ...(typeof message.data.cost === 'number'
            ? { reported_cost_usd: message.data.cost }
            : {}),
        },
      });

    for (const part of message.parts) {
      if (part.type !== 'tool' || !part.state) continue;
      const name = String(part.tool);
      const state: Row = part.state;
      const args: Row = state.input ?? {};
      const completed = state.status === 'completed';
      const bytes =
        completed && typeof state.output === 'string'
          ? Buffer.byteLength(state.output)
          : null;
      const base = resolve(directory, String(args.workdir ?? ''));
      const relativePath = (file: string) =>
        toWorktreeRelativePath(resolve(base, file), worktreeRoot);
      const targetsKnowledge = (file: string) =>
        isInside(knowledgeDir, resolve(base, file));
      const emitTool = (tool: ToolCall) =>
        push(offset, ts, { kind: 'tool_call', tool });
      const emitBypass = (file: string) =>
        push(offset, ts, {
          kind: 'bypass_read',
          path: relativePath(file),
          bytes,
        });

      if (name === 'read' && typeof args.filePath === 'string') {
        emitTool({
          name,
          action: 'read',
          path: relativePath(args.filePath),
          bytes,
        });
        if (targetsKnowledge(args.filePath)) emitBypass(args.filePath);
      } else if (EDIT_TOOLS.has(name) && typeof args.filePath === 'string') {
        if (completed)
          emitTool({
            name,
            action: 'edit',
            path: relativePath(args.filePath),
            bytes,
          });
      } else if (name === 'apply_patch') {
        if (completed)
          for (const file of patchPaths(args.patchText))
            emitTool({ name, action: 'edit', path: relativePath(file), bytes });
      } else if (SEARCH_TOOLS.has(name)) {
        const searched = typeof args.path === 'string' ? args.path : null;
        emitTool({
          name,
          action: 'search',
          path: searched === null ? null : relativePath(searched),
          bytes,
        });
        if (name === 'grep' && searched !== null && targetsKnowledge(searched))
          emitBypass(searched);
      } else if (name === 'bash' && typeof args.command === 'string') {
        const command = args.command;
        const segments = parseShell(command);
        const exit = shellExitCode(state);
        emitTool({
          name,
          action: 'shell',
          path: null,
          bytes,
          shell: { command, exit_code: exit },
        });
        if (!completed) continue;
        for (const file of shellWritePaths(segments))
          emitTool({
            name,
            action: 'edit',
            path: relativePath(file),
            bytes: null,
          });
        for (const arg of bypassReadArguments(segments))
          if (targetsKnowledge(arg)) emitBypass(arg);
        if (exit.value === 0 || exit.value === null)
          for (const bd of bdCommands(segments))
            push(offset, ts, { kind: 'bd_command', ...bd });
      }
    }
  }

  if (lastCreated !== undefined)
    push(lastCreated, iso(lastCreated), { kind: 'session_end' });

  return { events, checkpoint: { offset: checkpointOffset }, reason: null };
}

export const opencodeSource: SessionSource = {
  agent: 'opencode',
  discover,
  read,
};
