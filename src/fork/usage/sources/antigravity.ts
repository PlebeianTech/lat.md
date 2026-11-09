import { existsSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
import { findWorktreeRoot, worktreeRoots } from './worktrees.js';
import type { Checkpoint, ReadResult, SessionSource } from './types.js';
import { reportedTotal, tokenCounters } from './token-counters.js';

// @lat: [[usage-source-antigravity#Usage Source Antigravity#Session paths and the checkpoint cursor]]

type Row = Record<string, any>;

interface TranscriptLine {
  offset: number;
  record: Row;
}

interface SummaryRow {
  title: string;
  stepCount: number;
  workspaces: string[];
  parentId: string;
}

interface SummarySnapshot {
  signature: string;
  rows: Map<string, SummaryRow>;
}

const TRANSCRIPT_TAIL = join(
  '.system_generated',
  'logs',
  'transcript_full.jsonl',
);
const SINGLE_SLOT_KINDS = new Set([
  'session_start',
  'session_name',
  'session_end',
]);
const TOKEN_ROW_TYPES = new Set(['PLANNER_RESPONSE', 'CHECKPOINT']);
const READ_TOOLS: Record<string, string> = {
  read_file: 'Path',
  view_file: 'AbsolutePath',
};
const EDIT_TOOLS: Record<string, string> = {
  write_to_file: 'TargetFile',
  write_file: 'Path',
  edit_file: 'Path',
  replace_file_content: 'TargetFile',
};
const SEARCH_TOOLS: Record<string, string> = {
  grep_search: 'SearchPath',
  find_by_name: 'SearchDirectory',
  list_dir: 'DirectoryPath',
};
const EXIT_LINE = /^Command exited with code (-?\d+)\./m;
const BACKGROUND_FINISH =
  /sender=\S*\/task-(\d+)[\s\S]*?finished with result:\nCommand exited with code (-?\d+)\./;

let snapshotCache: { database: string; snapshot: SummarySnapshot } | null =
  null;

function storeDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli');
}

function sessionIdOf(transcriptPath: string): string {
  return basename(dirname(dirname(dirname(transcriptPath))));
}

function workspacePath(uri: string): string | null {
  try {
    return uri.startsWith('file://') ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

function parseWorkspaces(text: unknown): string[] {
  try {
    const list = JSON.parse(String(text));
    return Array.isArray(list)
      ? list
          .map((uri) => workspacePath(String(uri)))
          .filter((path): path is string => path !== null)
      : [];
  } catch {
    return [];
  }
}

async function loadSummaries(): Promise<SummarySnapshot | null> {
  const database = join(storeDir(), 'conversation_summaries.db');
  try {
    const stat = statSync(database);
    const walStat = existsSync(`${database}-wal`)
      ? statSync(`${database}-wal`)
      : null;
    const signature = `${stat.mtimeMs}:${stat.size}:${walStat ? `${walStat.mtimeMs}:${walStat.size}` : 'no-wal'}`;
    if (
      snapshotCache?.database === database &&
      snapshotCache.snapshot.signature === signature
    )
      return snapshotCache.snapshot;
    const { DatabaseSync } = await import('node:sqlite');
    const copyDir = await mkdtemp(join(tmpdir(), 'lat-agy-'));
    try {
      for (const suffix of ['', '-wal', '-shm'])
        if (existsSync(database + suffix))
          await copyFile(
            database + suffix,
            join(copyDir, `summaries.db${suffix}`),
          );
      const connection = new DatabaseSync(join(copyDir, 'summaries.db'), {
        readOnly: true,
      });
      try {
        const records = connection
          .prepare(
            'SELECT conversation_id, title, step_count, workspace_uris, parent_conversation_id FROM conversation_summaries',
          )
          .all() as Row[];
        const rows = new Map<string, SummaryRow>();
        for (const r of records)
          rows.set(String(r.conversation_id), {
            title: String(r.title ?? ''),
            stepCount: Number(r.step_count) || 0,
            workspaces: parseWorkspaces(r.workspace_uris),
            parentId: String(r.parent_conversation_id ?? ''),
          });
        const snapshot = { signature, rows };
        snapshotCache = { database, snapshot };
        return snapshot;
      } finally {
        connection.close();
      }
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

function loadHistoryWorkspaces(): Map<string, string> {
  const workspaces = new Map<string, string>();
  try {
    const text = readFileSync(join(storeDir(), 'history.jsonl'), 'utf-8');
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (
          typeof entry.conversationId === 'string' &&
          typeof entry.workspace === 'string'
        )
          workspaces.set(entry.conversationId, entry.workspace);
      } catch {
        continue;
      }
    }
  } catch {
    return workspaces;
  }
  return workspaces;
}

async function discover(repoRoot: string): Promise<string[]> {
  try {
    const roots = await worktreeRoots(repoRoot);
    const brain = join(storeDir(), 'brain');
    const summaries = await loadSummaries();
    const history = loadHistoryWorkspaces();
    const found: string[] = [];
    for (const entry of await readdir(brain, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const transcript = join(brain, entry.name, TRANSCRIPT_TAIL);
      if (!existsSync(transcript)) continue;
      const row = summaries?.rows.get(entry.name);
      if (row?.stepCount === 0) continue;
      const typed = history.get(entry.name);
      const workspaces = row ? row.workspaces : typed ? [typed] : [];
      if (workspaces.some((w) => roots.some((r) => isInside(r, w))))
        found.push(transcript);
    }
    return found.sort();
  } catch {
    return [];
  }
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

function toolCallsOf(record: Row): Row[] {
  return record.type === 'PLANNER_RESPONSE' && Array.isArray(record.tool_calls)
    ? record.tool_calls.filter((c: unknown) => c && typeof c === 'object')
    : [];
}

function resultsFor(lines: TranscriptLine[], index: number): Row[] {
  const wanted = toolCallsOf(lines[index].record).length;
  const results: Row[] = [];
  for (let i = index + 1; i < lines.length && results.length < wanted; i++) {
    const type = lines[i].record.type;
    if (type === 'PLANNER_RESPONSE' || type === 'USER_INPUT') break;
    if (type === 'GENERIC') results.push(lines[i].record);
  }
  return results;
}

function firstOpenTail(lines: TranscriptLine[]): TranscriptLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const type = lines[i].record.type;
    if (type === 'USER_INPUT') return null;
    if (type !== 'PLANNER_RESPONSE') continue;
    const incomplete =
      resultsFor(lines, i).length < toolCallsOf(lines[i].record).length;
    const followedByOtherRow = lines
      .slice(i + 1)
      .some((l) => l.record.type !== 'GENERIC');
    return incomplete && !followedByOtherRow ? lines[i] : null;
  }
  return null;
}

function shellExitCode(
  result: Row | undefined,
  finishedBackground: Map<number, number>,
): Captured<number> {
  if (!result) return { value: null, reason: 'not_captured' };
  if (result.status === 'RUNNING') {
    const code = finishedBackground.get(Number(result.step_index));
    return code === undefined
      ? { value: null, reason: 'not_captured' }
      : { value: code };
  }
  const match =
    result.status === 'DONE'
      ? EXIT_LINE.exec(String(result.content ?? ''))
      : null;
  return match
    ? { value: Number(match[1]) }
    : { value: null, reason: 'not_captured' };
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
      const sessionId = sessionIdOf(sessionPath);
      const summary = (await loadSummaries())?.rows.get(sessionId);
      const workspace =
        summary?.workspaces[0] ??
        (summary ? undefined : loadHistoryWorkspaces().get(sessionId));
      return readFrom(
        sessionPath,
        sessionId,
        summary,
        workspace,
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

function readFrom(
  sessionPath: string,
  sessionId: string,
  summary: SummaryRow | undefined,
  workspace: string | undefined,
  buffer: Buffer,
  start: number,
): ReadResult {
  const parsed = parseLines(buffer, start);
  const hold = firstOpenTail(parsed.lines);
  const lines = hold
    ? parsed.lines.filter((l) => l.offset < hold.offset)
    : parsed.lines;
  const checkpointOffset = hold ? hold.offset : parsed.end;

  const finishedBackground = new Map<number, number>();
  for (const { record } of parsed.lines) {
    if (record.type !== 'SYSTEM_MESSAGE') continue;
    const done = BACKGROUND_FINISH.exec(String(record.content ?? ''));
    if (done) finishedBackground.set(Number(done[1]), Number(done[2]));
  }

  const worktreeRoot = workspace
    ? findWorktreeRoot(workspace, new Map())
    : null;
  const knowledgeDir = worktreeRoot ? join(worktreeRoot, 'lat.md') : null;
  const absolute = (file: string) => resolve(workspace ?? '/', file);
  const relativePath = (file: string) =>
    worktreeRoot
      ? toWorktreeRelativePath(absolute(file), worktreeRoot)
      : absolute(file);
  const targetsKnowledge = (file: string) =>
    knowledgeDir !== null && isInside(knowledgeDir, absolute(file));
  const parent = summary?.parentId
    ? { parent_session_id: summary.parentId }
    : {};

  const events: SessionEvent[] = [];
  const perSlot = new Map<string, number>();
  let lastTs: string | null = null;
  let lastOffset: number | null = null;

  const push = (
    offset: number,
    ts: string,
    payload: Record<string, unknown>,
  ) => {
    const kind = String(payload.kind);
    const slotKey = `${offset}:${kind}`;
    const index = perSlot.get(slotKey) ?? 0;
    perSlot.set(slotKey, index + 1);
    const slot = SINGLE_SLOT_KINDS.has(kind) ? kind : `${kind}#${index}`;
    events.push({
      event_id: sessionEventId(`${sessionPath}#${slot}`, offset),
      session_id: sessionId,
      ...parent,
      ts,
      source: { path: sessionPath, offset },
      ...payload,
    } as SessionEvent);
  };

  const firstTs =
    lines.length > 0 ? String(lines[0].record.created_at ?? '') : '';
  if (start === 0 && lines.length > 0) {
    push(0, firstTs, { kind: 'session_start' });
    if (summary?.title)
      push(0, firstTs, { kind: 'session_name', name: summary.title });
  }

  lines.forEach(({ offset, record }, index) => {
    const ts: string =
      typeof record.created_at === 'string'
        ? record.created_at
        : (lastTs ?? firstTs);
    lastTs = ts;
    lastOffset = offset;

    if (TOKEN_ROW_TYPES.has(record.type)) {
      const usage = tokenCounters({
        input: record.input_tokens,
        output: record.output_tokens,
        cache_read: record.cache_read_tokens,
        cache_write: undefined,
        reasoning: undefined,
      });
      if (reportedTotal(usage) > 0)
        push(offset, ts, { kind: 'token_usage', usage });
    }

    const results = resultsFor(lines, index);
    toolCallsOf(record).forEach((call, callIndex) => {
      const name = String(call.name);
      const args: Row =
        call.args && typeof call.args === 'object' ? call.args : {};
      const result: Row | undefined = results[callIndex];
      const completed = result?.status === 'DONE';
      const bytes =
        result && typeof result.content === 'string'
          ? Buffer.byteLength(result.content)
          : null;
      const emitTool = (tool: ToolCall) =>
        push(offset, ts, { kind: 'tool_call', tool });
      const emitBypass = (file: string) =>
        push(offset, ts, {
          kind: 'bypass_read',
          path: relativePath(file),
          bytes,
        });
      const argument = (key: string): string | null =>
        typeof args[key] === 'string' ? args[key] : null;

      if (name in READ_TOOLS) {
        const file = argument(READ_TOOLS[name]);
        if (file === null) return;
        emitTool({ name, action: 'read', path: relativePath(file), bytes });
        if (targetsKnowledge(file)) emitBypass(file);
      } else if (name in EDIT_TOOLS) {
        const file = argument(EDIT_TOOLS[name]);
        if (file !== null && completed)
          emitTool({ name, action: 'edit', path: relativePath(file), bytes });
      } else if (name in SEARCH_TOOLS) {
        const target = argument(SEARCH_TOOLS[name]);
        emitTool({
          name,
          action: 'search',
          path: target === null ? null : relativePath(target),
          bytes,
        });
        if (
          name === 'grep_search' &&
          target !== null &&
          targetsKnowledge(target)
        )
          emitBypass(target);
      } else if (name === 'run_command') {
        const command = argument('CommandLine');
        if (command === null) return;
        const segments = parseShell(command);
        const exit = shellExitCode(result, finishedBackground);
        emitTool({
          name,
          action: 'shell',
          path: null,
          bytes,
          shell: { command, exit_code: exit },
        });
        if (exit.value !== null && exit.value !== 0) return;
        for (const file of shellWritePaths(segments))
          emitTool({
            name,
            action: 'edit',
            path: relativePath(file),
            bytes: null,
          });
        for (const arg of bypassReadArguments(segments))
          if (targetsKnowledge(arg)) emitBypass(arg);
        for (const bd of bdCommands(segments))
          push(offset, ts, { kind: 'bd_command', ...bd });
      }
    });
  });

  if (lastOffset !== null && lastTs)
    push(lastOffset, lastTs, { kind: 'session_end' });

  return {
    events,
    checkpoint: { offset: checkpointOffset },
    reason: summary || workspace ? null : 'not_captured',
  };
}

export const antigravitySource: SessionSource = {
  agent: 'antigravity',
  discover,
  read,
};
