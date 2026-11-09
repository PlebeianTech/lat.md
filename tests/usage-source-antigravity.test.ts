import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/fork/usage/schema.js';
import { antigravitySource } from '../src/fork/usage/sources/antigravity.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'usage', 'antigravity');
const MAIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const CHILD = 'aaaaaaaa-0000-4000-8000-000000000002';
const STUB = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';
const TYPED = 'aaaaaaaa-0000-4000-8000-000000000005';

let scratch: string;
let repo: string;
let store: string;
const savedHome = process.env.HOME;

function ofKind<K extends SessionEvent['kind']>(
  events: SessionEvent[],
  kind: K,
): Extract<SessionEvent, { kind: K }>[] {
  return events.filter((e) => e.kind === kind) as Extract<
    SessionEvent,
    { kind: K }
  >[];
}

function toolCalls(events: SessionEvent[]) {
  return ofKind(events, 'tool_call').map((e) => e.tool);
}

function transcriptPath(id: string): string {
  return join(
    store,
    'brain',
    id,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
}

function installTranscript(id: string, fixture: string) {
  const text = readFileSync(join(FIXTURES, fixture), 'utf-8').replaceAll(
    '{{ROOT}}',
    repo,
  );
  mkdirSync(join(store, 'brain', id, '.system_generated', 'logs'), {
    recursive: true,
  });
  writeFileSync(transcriptPath(id), text);
}

function installStore() {
  installTranscript(MAIN, 'main.jsonl');
  installTranscript(CHILD, 'child.jsonl');
  installTranscript(STUB, 'child.jsonl');
  installTranscript(OTHER, 'other.jsonl');
  installTranscript(TYPED, 'other.jsonl');

  const db = new DatabaseSync(join(store, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "",
    step_count integer NOT NULL DEFAULT 0, workspace_uris text NOT NULL,
    parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0,
    agent_name text NOT NULL DEFAULT "")`);
  const insert = db.prepare(
    'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const uri = (path: string) => JSON.stringify([`file://${path}`]);
  insert.run(MAIN, 'Synthetic agy session', 25, uri(repo), '', 0, '');
  insert.run(CHILD, '', 4, uri(repo), MAIN, 1, 'research');
  insert.run(STUB, '', 0, uri(repo), MAIN, 1, 'self');
  insert.run(OTHER, 'Elsewhere', 2, uri(join(scratch, 'elsewhere')), '', 0, '');
  insert.run(
    'aaaaaaaa-0000-4000-8000-000000000006',
    'No workspace',
    3,
    '[]',
    '',
    0,
    '',
  );
  db.close();

  writeFileSync(
    join(store, 'history.jsonl'),
    `${JSON.stringify({ display: 'p', timestamp: 1, workspace: repo, conversationId: TYPED })}\nnot json\n`,
  );
}

function filesUnder(dir: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      for (const [p, m] of filesUnder(path)) found.set(p, m);
    else found.set(path, statSync(path).mtimeMs);
  }
  return found;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'usage-agy-')));
  repo = join(scratch, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  store = join(scratch, 'home', '.gemini', 'antigravity-cli');
  mkdirSync(store, { recursive: true });
  process.env.HOME = join(scratch, 'home');
  installStore();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

async function readMain() {
  return antigravitySource.read(transcriptPath(MAIN), null);
}

describe('antigravity session reader', () => {
  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Session paths and the checkpoint cursor]]
  it('derives event ids from the transcript path and line offset', async () => {
    const { events } = await readMain();

    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    for (const event of events)
      expect(event.source.path).toBe(transcriptPath(MAIN));
    const lines = readFileSync(transcriptPath(MAIN), 'utf-8').split('\n');
    const offsetOfStep = (step: number) =>
      Buffer.byteLength(
        lines
          .slice(0, step)
          .map((l) => l + '\n')
          .join(''),
      );
    expect(ofKind(events, 'token_usage').map((e) => e.source.offset)).toEqual(
      [2, 6, 16, 23, 24].map(offsetOfStep),
    );
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Discovery matches sessions through the summaries database]]
  it('discovers conversations of the repo and skips stubs and strangers', async () => {
    expect(await antigravitySource.discover(repo)).toEqual(
      [MAIN, CHILD, TYPED].map(transcriptPath),
    );
    expect(await antigravitySource.discover(join(scratch, 'none'))).toEqual([]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Session lifecycle and name]]
  it('emits session start, name and end', async () => {
    const { events, reason } = await readMain();

    expect(reason).toBeNull();
    expect(events[0].kind).toBe('session_start');
    expect(events[0].session_id).toBe(MAIN);
    expect(events[0].ts).toBe('2026-11-08T12:00:00Z');
    expect(ofKind(events, 'session_name').map((e) => e.name)).toEqual([
      'Synthetic agy session',
    ]);
    const end = ofKind(events, 'session_end');
    expect(end).toHaveLength(1);
    expect(end[0].ts).toBe('2026-11-08T12:00:24Z');
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Subagent conversations are their own sessions]]
  it('emits a subagent conversation as its own session with its parent', async () => {
    const child = await antigravitySource.read(transcriptPath(CHILD), null);
    const main = await readMain();

    expect(child.events.length).toBeGreaterThan(0);
    for (const event of child.events) {
      expect(event.session_id).toBe(CHILD);
      expect(event.parent_session_id).toBe(MAIN);
    }
    expect(ofKind(child.events, 'session_name')).toEqual([]);
    for (const event of main.events) {
      expect(event.session_id).toBe(MAIN);
      expect(event.parent_session_id).toBeUndefined();
    }
    expect(toolCalls(child.events).map((t) => t.path)).toContain('src/c.ts');
    expect(toolCalls(main.events).map((t) => t.path)).not.toContain('src/c.ts');
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Edit tools yield edit events]]
  it('turns agy file-editing tools into edit events', async () => {
    const { events } = await readMain();

    const edits = toolCalls(events).filter((t) => t.action === 'edit');
    expect(edits.map((t) => [t.name, t.path])).toEqual([
      ['run_command', 'out.txt'],
      ['edit_file', 'src/a.ts'],
      ['replace_file_content', 'src/b.ts'],
    ]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Shell calls carry command and exit code]]
  it('records command text and exit code, null when not captured', async () => {
    const { events } = await readMain();

    const shells = toolCalls(events).flatMap((t) =>
      t.action === 'shell' ? [t.shell] : [],
    );
    expect(shells.map((s) => [s.command, s.exit_code])).toEqual([
      ['lat search "usage"', { value: 0 }],
      ['bd update lat-1.2 --claim', { value: 0 }],
      [`cat ${repo}/lat.md/notes.md`, { value: 0 }],
      ['echo hi > out.txt', { value: 0 }],
      ['bd close lat-1.2 lat-1.3 --reason finished', { value: 0 }],
      ['bd close lat-9', { value: 1 }],
      ['sleep 5 && lat check', { value: 0 }],
      ['sleep 600', { value: null, reason: 'not_captured' }],
      ['lat expand "[[x]]"', { value: null, reason: 'not_captured' }],
    ]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Reads and searches]]
  it('maps read and search tools with worktree-relative paths', async () => {
    const { events } = await readMain();

    const by = (action: string) =>
      toolCalls(events)
        .filter((t) => t.action === action)
        .map((t) => [t.name, t.path]);
    expect(by('read')).toEqual([
      ['read_file', 'lat.md/usage.md'],
      ['read_file', 'src/a.ts'],
    ]);
    expect(by('search')).toEqual([
      ['grep_search', 'lat.md'],
      ['list_dir', 'src'],
    ]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Lat commands appear as shell calls]]
  it('counts lat commands in run_command and not in prompt text', async () => {
    const { events } = await readMain();

    const commands = toolCalls(events).flatMap((t) =>
      t.action === 'shell' ? [t.shell.command] : [],
    );
    expect(commands.filter((c) => c.startsWith('lat '))).toEqual([
      'lat search "usage"',
      'lat expand "[[x]]"',
    ]);
    expect(ofKind(events, 'bd_command').map((e) => e.issue_id)).not.toContain(
      'lat-0',
    );
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Bypass reads target the knowledge directory]]
  it('flags reads, greps and shell readers aimed at lat.md/', async () => {
    const { events } = await readMain();

    expect(ofKind(events, 'bypass_read').map((e) => e.path)).toEqual([
      'lat.md/usage.md',
      'lat.md/notes.md',
      'lat.md',
    ]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Beads claim and close carry issue ids]]
  it('extracts claim and close issue ids and skips failed commands', async () => {
    const { events } = await readMain();

    expect(
      ofKind(events, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([
      ['claim', 'lat-1.2'],
      ['close', 'lat-1.2'],
      ['close', 'lat-1.3'],
    ]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Token usage splits the cache]]
  it('emits one token usage per model turn and checkpoint row', async () => {
    const { events } = await readMain();

    expect(
      ofKind(events, 'token_usage').map((e) => [
        e.usage.input,
        e.usage.cache_read,
        e.usage.output,
        e.usage.cache_write,
        e.usage.reasoning,
        e.usage.unknown_reasons,
      ]),
    ).toEqual(
      [
        [100, 40, 10],
        [50, 140, 20],
        [30, 200, 5],
        [7, 3, 2],
        [10, 20, 5],
      ].map((counts) => [
        ...counts,
        null,
        null,
        {
          cache_write: 'unsupported_by_agent',
          reasoning: 'unsupported_by_agent',
        },
      ]),
    );
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#A counter the transcript leaves out is unknown]]
  it('reports a token counter the row leaves out as null with a reason', async () => {
    const rows = [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-08T12:00:01Z',
        input_tokens: 5,
        output_tokens: 0,
        tool_calls: [],
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-08T12:00:02Z',
        content: 'next',
      },
    ];
    writeFileSync(
      transcriptPath(OTHER),
      rows.map((r) => JSON.stringify(r) + '\n').join(''),
    );
    const { events } = await antigravitySource.read(
      transcriptPath(OTHER),
      null,
    );
    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 5,
        output: 0,
        cache_read: null,
        cache_write: null,
        reasoning: null,
        unknown_reasons: {
          cache_read: 'unsupported_by_agent',
          cache_write: 'unsupported_by_agent',
          reasoning: 'unsupported_by_agent',
        },
      },
    ]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Shell writes add edit events]]
  it('adds a null-bytes edit event beside the shell record', async () => {
    const { events } = await readMain();

    const calls = toolCalls(events);
    const shellAt = calls.findIndex(
      (t) => t.action === 'shell' && t.shell.command === 'echo hi > out.txt',
    );
    expect(calls[shellAt + 1]).toMatchObject({
      action: 'edit',
      path: 'out.txt',
      bytes: null,
    });
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Resume from a checkpoint]]
  it('resumes from the checkpoint and holds a turn with unwritten results', async () => {
    const whole = readFileSync(transcriptPath(MAIN), 'utf-8');
    const full = await readMain();
    const prefix = whole.split('\n').slice(0, 9).join('\n') + '\n';

    writeFileSync(transcriptPath(MAIN), prefix);
    const first = await antigravitySource.read(transcriptPath(MAIN), null);
    expect(ofKind(first.events, 'token_usage')).toHaveLength(1);
    expect(first.checkpoint.offset).toBeLessThan(Buffer.byteLength(prefix));

    writeFileSync(transcriptPath(MAIN), whole);
    const second = await antigravitySource.read(
      transcriptPath(MAIN),
      first.checkpoint,
    );
    expect(ofKind(second.events, 'session_start')).toEqual([]);
    const ids = [...first.events, ...second.events]
      .filter((e) => e.kind !== 'session_end')
      .map((e) => e.event_id);
    expect(ids).toEqual(
      full.events
        .filter((e) => e.kind !== 'session_end')
        .map((e) => e.event_id),
    );
    expect(ofKind(second.events, 'token_usage')).toHaveLength(4);

    const again = await antigravitySource.read(
      transcriptPath(MAIN),
      second.checkpoint,
    );
    expect(again.events).toEqual([]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Resume from a checkpoint]]
  it('releases a turn with missing results once a later row follows it', async () => {
    const lines = readFileSync(transcriptPath(MAIN), 'utf-8').split('\n');
    const short = lines.slice(0, 9).join('\n') + '\n';
    const later = JSON.stringify({
      step_index: 9,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-08T12:00:09Z',
      content: 'note',
    });

    writeFileSync(transcriptPath(MAIN), short + later + '\n');
    const first = await antigravitySource.read(transcriptPath(MAIN), null);
    const turn = ofKind(first.events, 'token_usage').filter(
      (e) => e.usage.input === 50,
    );
    expect(turn).toHaveLength(1);
    const shells = toolCalls(first.events).flatMap((t) =>
      t.action === 'shell' ? [t.shell] : [],
    );
    expect(shells.map((s) => s.exit_code)).toEqual([
      { value: 0 },
      { value: 0 },
      { value: 0 },
      { value: null, reason: 'not_captured' },
    ]);
    expect(
      toolCalls(first.events).filter(
        (t) => t.action === 'edit' && t.name === 'edit_file',
      ),
    ).toEqual([]);

    const second = await antigravitySource.read(
      transcriptPath(MAIN),
      first.checkpoint,
    );
    expect(ofKind(second.events, 'token_usage')).toEqual([]);
    expect(toolCalls(second.events)).toEqual([]);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Discovery matches sessions through the summaries database]]
  it('sees rows that reach only the write-ahead log after the first read', async () => {
    rmSync(join(store, 'conversation_summaries.db'));
    const db = new DatabaseSync(join(store, 'conversation_summaries.db'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0, workspace_uris text NOT NULL,
      parent_conversation_id text NOT NULL DEFAULT "")`);
    const insert = db.prepare(
      'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)',
    );
    const uris = JSON.stringify([`file://${repo}`]);
    insert.run(MAIN, 'Top', 25, uris, '');
    try {
      expect(await antigravitySource.discover(repo)).toEqual([
        transcriptPath(MAIN),
        transcriptPath(TYPED),
      ]);
      const mainFile = statSync(join(store, 'conversation_summaries.db'));

      insert.run(CHILD, '', 4, uris, MAIN);
      const after = statSync(join(store, 'conversation_summaries.db'));
      expect([after.mtimeMs, after.size]).toEqual([
        mainFile.mtimeMs,
        mainFile.size,
      ]);
      expect(await antigravitySource.discover(repo)).toContain(
        transcriptPath(CHILD),
      );
      const child = await antigravitySource.read(transcriptPath(CHILD), null);
      expect(child.events[0].parent_session_id).toBe(MAIN);
    } finally {
      db.close();
    }
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Reading never modifies the store]]
  it('leaves every file under the store untouched', async () => {
    const tempCopies = () =>
      readdirSync(tmpdir()).filter((n) => n.startsWith('lat-agy-'));
    const before = filesUnder(join(scratch, 'home'));
    const copiesBefore = tempCopies();

    await antigravitySource.discover(repo);
    await readMain();
    await antigravitySource.read(transcriptPath(CHILD), null);

    expect(filesUnder(join(scratch, 'home'))).toEqual(before);
    expect(tempCopies()).toEqual(copiesBefore);
  });

  // @lat: [[usage-source-antigravity#Usage Source Antigravity#Unreadable store returns a reason]]
  it('returns a reason instead of throwing on an unreadable store', async () => {
    const missing = await antigravitySource.read(
      transcriptPath('aaaaaaaa-0000-4000-8000-0000000000ff'),
      null,
    );
    expect(missing).toEqual({
      events: [],
      checkpoint: { offset: 0 },
      reason: 'transcript_expired',
    });

    writeFileSync(join(store, 'conversation_summaries.db'), 'not a database');
    const noRow = await readMain();
    expect(noRow.events.length).toBeGreaterThan(0);
    expect(noRow.reason).toBe('not_captured');
    expect(await antigravitySource.discover(repo)).toEqual([
      transcriptPath(TYPED),
    ]);

    rmSync(join(store, 'brain'), { recursive: true });
    expect(await antigravitySource.discover(repo)).toEqual([]);
  });
});
