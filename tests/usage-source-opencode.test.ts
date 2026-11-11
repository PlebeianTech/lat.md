import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/fork/usage/schema.js';
import { opencodeSource } from '../src/fork/usage/sources/opencode.js';
import { addSessionEvent, emptyState } from '../src/fork/usage/state.js';

const FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'usage',
  'opencode',
  'main.json',
);

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

function shellCalls(events: SessionEvent[]) {
  return toolCalls(events).filter((t) => t.action === 'shell');
}

let scratch: string;
let repo: string;
let database: string;
const savedDataHome = process.env.XDG_DATA_HOME;

function sessionPath(id: string): string {
  return `${database}#${id}`;
}

function loadFixture(): DatabaseSync {
  const text = readFileSync(FIXTURE, 'utf-8')
    .replaceAll('{{ROOT}}', repo)
    .replaceAll('{{SCRATCH}}', scratch);
  const rows = JSON.parse(text);
  mkdirSync(join(scratch, 'data', 'opencode'), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, data text NOT NULL);
  `);
  for (const s of rows.sessions)
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
      s.id,
      s.parent_id,
      s.directory,
      s.title,
      s.time_created,
      s.time_created,
    );
  for (const m of rows.messages)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      m.id,
      m.session_id,
      m.time_created,
      JSON.stringify(m.data),
    );
  for (const p of rows.parts)
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      p.id,
      p.message_id,
      p.session_id,
      JSON.stringify(p.data),
    );
  return db;
}

function finishTailMessage(db: DatabaseSync) {
  const row = db
    .prepare("SELECT data FROM message WHERE id = 'msg_04'")
    .get() as { data: string };
  const data = JSON.parse(row.data);
  data.time.completed = 4500;
  data.tokens.input = 11;
  db.prepare("UPDATE message SET data = ? WHERE id = 'msg_04'").run(
    JSON.stringify(data),
  );
  db.prepare("UPDATE part SET data = ? WHERE id = 'prt_04a'").run(
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'sleep 100' },
        output: '',
        metadata: { exit: 0 },
      },
    }),
  );
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'usage-opencode-')));
  repo = join(scratch, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  database = join(scratch, 'data', 'opencode', 'opencode.db');
  process.env.XDG_DATA_HOME = join(scratch, 'data');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
});

async function readMain() {
  loadFixture().close();
  return opencodeSource.read(sessionPath('ses_main'), null);
}

describe('opencode session reader', () => {
  // @lat: [[usage-source-opencode#Usage Source OpenCode#Session paths and the checkpoint cursor]]
  it('derives event ids from the session path and message time', async () => {
    const { events } = await readMain();

    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    for (const event of events)
      expect(event.source.path).toBe(sessionPath('ses_main'));
    expect(ofKind(events, 'token_usage').map((e) => e.source.offset)).toEqual([
      2000, 3000,
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Session paths and the checkpoint cursor]]
  it('names the database and its write-ahead log as the change files', () => {
    expect(opencodeSource.changeFiles?.(sessionPath('ses_main'))).toEqual([
      database,
      `${database}-wal`,
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Discovery matches sessions by directory]]
  it('discovers sessions inside the repo or a worktree', async () => {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { stdio: 'ignore' },
      );
    rmSync(join(repo, '.git'), { recursive: true });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = join(scratch, 'repo-wt');
    git('worktree', 'add', '-q', worktree);
    const db = loadFixture();
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
      'ses_wt',
      null,
      worktree,
      'In worktree',
      1,
      1,
    );
    db.close();

    expect(await opencodeSource.discover(repo)).toEqual([
      sessionPath('ses_child'),
      sessionPath('ses_main'),
      sessionPath('ses_wt'),
    ]);
    expect(await opencodeSource.discover(join(scratch, 'none'))).toEqual([]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Session lifecycle, name and model]]
  it('emits session start, name, models and end', async () => {
    const { events } = await readMain();

    expect(events[0].kind).toBe('session_start');
    expect(events[0].session_id).toBe('ses_main');
    expect(events[0].ts).toBe('1970-01-01T00:00:01.000Z');
    expect(ofKind(events, 'session_name').map((e) => e.name)).toEqual([
      'Synthetic opencode session',
    ]);
    expect(ofKind(events, 'model').map((e) => e.model)).toEqual([
      'model-a',
      'model-b',
    ]);
    const end = ofKind(events, 'session_end');
    expect(end).toHaveLength(1);
    expect(end[0].ts).toBe('1970-01-01T00:00:03.000Z');
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Session lifecycle, name and model]]
  it('replaces the stored name when the session is renamed later', async () => {
    const db = loadFixture();
    const state = emptyState();
    const ingest = async () => {
      const { events } = await opencodeSource.read(
        sessionPath('ses_main'),
        null,
      );
      for (const event of events) addSessionEvent(state, 'opencode', event);
    };
    await ingest();
    db.prepare(
      "UPDATE session SET title = 'Renamed', time_updated = 9000 WHERE id = 'ses_main'",
    ).run();
    db.close();
    await ingest();

    const names = Object.values(state.sessions)
      .map((s) => s.event)
      .filter((e) => e.kind === 'session_name');
    expect(names.map((e) => (e as { name: string }).name)).toEqual(['Renamed']);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Subagent sessions name their parent]]
  it('marks every event of a subagent session with its parent', async () => {
    loadFixture().close();
    const child = await opencodeSource.read(sessionPath('ses_child'), null);

    expect(child.events.length).toBeGreaterThan(0);
    for (const event of child.events)
      expect(event.parent_session_id).toBe('ses_main');
    expect(ofKind(child.events, 'session_name')).toEqual([]);
    for (const event of (
      await opencodeSource.read(sessionPath('ses_main'), null)
    ).events)
      expect('parent_session_id' in event).toBe(false);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Edit tools yield edit events]]
  it('yields edit events for edit, write and apply_patch', async () => {
    const { events } = await readMain();

    expect(
      toolCalls(events)
        .filter((t) => ['edit', 'write', 'apply_patch'].includes(t.name))
        .map((t) => [t.name, t.action, t.path]),
    ).toEqual([
      ['edit', 'edit', 'src/a.ts'],
      ['write', 'edit', 'src/new.ts'],
      ['apply_patch', 'edit', 'src/b.ts'],
      ['apply_patch', 'edit', join(scratch, 'other', 'z.txt')],
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Shell calls carry command and exit code]]
  it('carries shell command and exit code, null when unknown', async () => {
    const { events } = await readMain();
    const byCommand = new Map(
      shellCalls(events).map((t) => [t.shell?.command, t.shell?.exit_code]),
    );

    expect(byCommand.get('lat search "token budget"')).toEqual({ value: 0 });
    expect(byCommand.get('pnpm test')).toEqual({ value: 2 });
    expect(byCommand.get('echo hi > out.txt')).toEqual({
      value: null,
      reason: 'not_captured',
    });
    expect(byCommand.get('bd close lat-y.9')).toEqual({
      value: null,
      reason: 'not_captured',
    });
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Reads and searches]]
  it('maps read to read and grep and glob to search', async () => {
    const { events } = await readMain();

    expect(
      toolCalls(events)
        .filter((t) => ['read', 'grep', 'glob'].includes(t.name))
        .map((t) => [t.name, t.action, t.path]),
    ).toEqual([
      ['read', 'read', 'lat.md/notes.md'],
      ['grep', 'search', 'lat.md'],
      ['glob', 'search', 'src'],
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Lat commands appear as shell calls]]
  it('records a lat command as a shell call', async () => {
    const { events } = await readMain();

    expect(shellCalls(events).map((t) => t.shell?.command)).toContain(
      'lat search "token budget"',
    );
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Bypass reads target the knowledge directory]]
  it('flags reads, greps and cats aimed at lat.md/', async () => {
    const { events } = await readMain();

    expect(ofKind(events, 'bypass_read').map((e) => [e.path, e.bytes])).toEqual(
      [
        ['lat.md/notes.md', 12],
        ['lat.md/spec.md', 9],
        ['lat.md', 15],
      ],
    );
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#An errored read or grep is not a bypass read]]
  it('records an errored read or grep without a bypass read', async () => {
    const db = loadFixture();
    const fail = (id: string, tool: string, input: object) =>
      db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({
          type: 'tool',
          tool,
          state: { status: 'error', input, error: 'File not found' },
        }),
        id,
      );
    fail('prt_02b', 'read', { filePath: `${repo}/lat.md/notes.md` });
    fail('prt_03g', 'grep', { pattern: 'widget', path: `${repo}/lat.md` });
    db.close();
    const { events } = await opencodeSource.read(sessionPath('ses_main'), null);

    expect(
      toolCalls(events)
        .filter((t) => ['read', 'grep'].includes(t.name))
        .map((t) => t.name),
    ).toEqual(['read', 'grep']);
    expect(ofKind(events, 'bypass_read').map((e) => e.path)).toEqual([
      'lat.md/spec.md',
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Beads claim and close carry issue ids]]
  it('emits claim and close with issue ids, skipping rejected commands', async () => {
    const { events } = await readMain();

    expect(
      ofKind(events, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([
      ['claim', 'lat-x.1'],
      ['close', 'lat-x.1'],
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Token usage splits the cache]]
  it('emits one token usage per completed message with the cache split', async () => {
    const { events } = await readMain();

    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 100,
        output: 20,
        cache_read: 300,
        cache_write: 40,
        reasoning: 5,
        reported_cost_usd: 0.01,
      },
      {
        input: 7,
        output: 3,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        reported_cost_usd: 0,
      },
    ]);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#A counter the transcript leaves out is unknown]]
  it('reports a token counter the message leaves out as null with a reason', async () => {
    const db = loadFixture();
    const row = db
      .prepare("SELECT data FROM message WHERE id = 'msg_03'")
      .get() as { data: string };
    const data = JSON.parse(row.data);
    data.tokens = { input: 7, output: 0 };
    db.prepare("UPDATE message SET data = ? WHERE id = 'msg_03'").run(
      JSON.stringify(data),
    );
    db.close();
    const { events } = await opencodeSource.read(sessionPath('ses_main'), null);
    expect(ofKind(events, 'token_usage')[1].usage).toEqual({
      input: 7,
      output: 0,
      cache_read: null,
      cache_write: null,
      reasoning: null,
      unknown_reasons: {
        cache_read: 'unsupported_by_agent',
        cache_write: 'unsupported_by_agent',
        reasoning: 'unsupported_by_agent',
      },
      reported_cost_usd: 0,
    });
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Shell writes add edit events]]
  it('adds an edit with null bytes for a shell redirect, beside the shell record', async () => {
    const { events } = await readMain();
    const edits = toolCalls(events).filter(
      (t) => t.name === 'bash' && t.action === 'edit',
    );

    expect(edits.map((t) => [t.path, t.bytes])).toEqual([
      ['src/out.txt', null],
    ]);
    expect(
      shellCalls(events).some((t) => t.shell?.command === 'echo hi > out.txt'),
    ).toBe(true);
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Resume from a checkpoint]]
  it('resumes at the held message and counts its tokens once', async () => {
    const db = loadFixture();
    const first = await opencodeSource.read(sessionPath('ses_main'), null);
    expect(first.checkpoint.offset).toBe(4000);
    expect(ofKind(first.events, 'token_usage')).toHaveLength(2);
    expect(shellCalls(first.events).map((t) => t.shell?.command)).not.toContain(
      'sleep 100',
    );

    finishTailMessage(db);
    db.close();
    const second = await opencodeSource.read(
      sessionPath('ses_main'),
      first.checkpoint,
    );
    expect(second.checkpoint.offset).toBe(4001);
    expect(ofKind(second.events, 'session_start')).toEqual([]);
    expect(
      ofKind(second.events, 'token_usage').map((e) => e.usage.input),
    ).toEqual([11]);
    expect(shellCalls(second.events).map((t) => t.shell?.command)).toEqual([
      'sleep 100',
    ]);

    const third = await opencodeSource.read(
      sessionPath('ses_main'),
      second.checkpoint,
    );
    expect(third.events).toEqual([]);
    expect(third.checkpoint).toEqual(second.checkpoint);

    const whole = await opencodeSource.read(sessionPath('ses_main'), null);
    const ids = (events: SessionEvent[]) =>
      events
        .filter((e) =>
          ['tool_call', 'token_usage', 'bd_command', 'bypass_read'].includes(
            e.kind,
          ),
        )
        .map((e) => e.event_id)
        .sort();
    expect(ids([...first.events, ...second.events])).toEqual(ids(whole.events));
  });

  // @lat: [[usage-source-opencode#Usage Source OpenCode#Unreadable store returns a reason]]
  it('returns a reason and no events for an unreadable store', async () => {
    const missing = await opencodeSource.read(sessionPath('ses_main'), null);
    expect(missing).toEqual({
      events: [],
      checkpoint: { offset: 0 },
      reason: 'transcript_expired',
    });
    expect(await opencodeSource.discover(repo)).toEqual([]);

    mkdirSync(join(scratch, 'data', 'opencode'), { recursive: true });
    writeFileSync(database, 'this is not a database');
    expect(
      (await opencodeSource.read(sessionPath('ses_main'), null)).reason,
    ).toBe('not_captured');
    expect(await opencodeSource.discover(repo)).toEqual([]);

    rmSync(database);
    loadFixture().close();
    expect(
      await opencodeSource.read(sessionPath('ses_nope'), { offset: 5 }),
    ).toEqual({
      events: [],
      checkpoint: { offset: 5 },
      reason: 'not_captured',
    });
    expect(await opencodeSource.read('no-separator', null)).toEqual({
      events: [],
      checkpoint: { offset: 0 },
      reason: 'not_captured',
    });
  });
});
