import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/fork/usage/schema.js';
import { codexSource } from '../src/fork/usage/sources/codex.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'usage', 'codex');
const MAIN_ID = 'sess-main-0001';

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
let home: string;
const savedHome = process.env.CODEX_HOME;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'usage-codex-')));
  home = join(scratch, 'codex-home');
  mkdirSync(join(home, 'sessions', '2026', '11', '08'), { recursive: true });
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
});

function installFixture(fixture: string, name: string): string {
  const target = join(home, 'sessions', '2026', '11', '08', name);
  cpSync(join(FIXTURES, fixture), target);
  return target;
}

function installIndex() {
  cpSync(
    join(FIXTURES, 'session_index.jsonl'),
    join(home, 'session_index.jsonl'),
  );
}

let sequence = 0;

function record(type: string, payload: object) {
  sequence += 1;
  return {
    timestamp: `2026-11-08T11:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    ordinal: sequence,
    type,
    payload,
  };
}

function metaRecord(cwd: string, id = 'sess-gen') {
  return record('session_meta', { id, session_id: id, cwd });
}

function commandRecord(script: string, extra: Record<string, unknown> = {}) {
  return record('event_msg', {
    type: 'item_completed',
    item: {
      type: 'CommandExecution',
      command: ['/bin/zsh', '-lc', script],
      cwd: 'file:///work/repo',
      parsed_cmd: [{ type: 'unknown', cmd: script }],
      status: 'completed',
      aggregated_output: 'ok',
      exit_code: 0,
      ...extra,
    },
  });
}

function writeRollout(
  records: object[],
  name = 'rollout-gen.jsonl',
  cwd = '/work/repo',
): string {
  const path = join(home, 'sessions', '2026', '11', '08', name);
  const lines = [metaRecord(cwd), ...records];
  writeFileSync(path, lines.map((r) => JSON.stringify(r) + '\n').join(''));
  return path;
}

async function readCommand(script: string, extra = {}) {
  const path = writeRollout([commandRecord(script, extra)]);
  return (await codexSource.read(path, null)).events;
}

describe('codex session reader', () => {
  // @lat: [[usage-source-codex#Usage Source Codex#Discovery matches sessions by working directory]]
  it('discovers sessions whose cwd is inside the repo or a worktree', async () => {
    const repoRoot = join(scratch, 'repo');
    const worktree = join(scratch, 'repo-wt');
    mkdirSync(repoRoot);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { stdio: 'ignore' },
      );
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', worktree);

    const inRepo = writeRollout([], 'rollout-a.jsonl', join(repoRoot, 'src'));
    const inWorktree = writeRollout([], 'rollout-b.jsonl', worktree);
    writeRollout([], 'rollout-c.jsonl', join(scratch, 'elsewhere'));
    writeFileSync(
      join(home, 'sessions', '2026', '11', '08', 'notes.jsonl'),
      JSON.stringify(metaRecord(repoRoot)) + '\n',
    );
    writeFileSync(
      join(home, 'sessions', '2026', '11', '08', 'rollout-d.jsonl'),
      'not json\n',
    );

    expect(await codexSource.discover(repoRoot)).toEqual(
      [inRepo, inWorktree].sort(),
    );
    expect(await codexSource.discover(join(scratch, 'none'))).toEqual([]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Subagent events name their parent session]]
  it('sets parent_session_id on subagent events and skips replayed history', async () => {
    const path = installFixture('subagent.jsonl', 'rollout-sub.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.session_id).toBe('sess-sub-0002');
      expect(event.parent_session_id).toBe(MAIN_ID);
    }
    expect(shellCalls(events).map((t) => t.shell?.command)).toEqual([
      'lat section "a#b"',
    ]);

    const main = await codexSource.read(
      installFixture('main.jsonl', 'rollout-main.jsonl'),
      null,
    );
    for (const event of main.events)
      expect('parent_session_id' in event).toBe(false);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Session lifecycle, name and model]]
  it('emits session start, name, models and end', async () => {
    installIndex();
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(events[0].kind).toBe('session_start');
    expect(events[0].session_id).toBe(MAIN_ID);
    expect(ofKind(events, 'session_name').map((e) => e.name)).toEqual([
      'Synthetic session name',
    ]);
    expect(ofKind(events, 'model').map((e) => e.model)).toEqual([
      'model-a',
      'model-b',
    ]);
    const end = ofKind(events, 'session_end');
    expect(end).toHaveLength(1);
    expect(end[0].ts).toBe('2026-11-08T10:00:17.000Z');
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Patches yield edit events]]
  it('yields an edit for every path in a patch, relative to the worktree', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(
      toolCalls(events)
        .filter((t) => t.name === 'apply_patch')
        .map((t) => [t.action, t.path]),
    ).toEqual([
      ['edit', 'src/a.ts'],
      ['edit', 'src/b.ts'],
      ['edit', '/other/z.txt'],
    ]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Shell calls carry command and exit code]]
  it('carries shell command and exit code, null when unknown', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);
    const byCommand = new Map(
      shellCalls(events).map((t) => [t.shell?.command, t.shell?.exit_code]),
    );

    expect(byCommand.get('lat search "token budget"')).toEqual({ value: 0 });
    expect(byCommand.get('pnpm test')).toEqual({ value: 2 });
    expect(byCommand.get('sleep 100 &')).toEqual({
      value: null,
      reason: 'not_captured',
    });

    const negative = await readCommand('pkill x', { exit_code: -1 });
    expect(shellCalls(negative)[0].shell?.exit_code).toEqual({
      value: null,
      reason: 'not_captured',
    });
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Reads and searches come from parsed commands]]
  it('maps parsed reads, searches and image views to actions', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);
    const tools = toolCalls(events);

    expect(tools.filter((t) => t.action === 'read').map((t) => t.path)).toEqual(
      ['lat.md/cli.md', 'src/a.ts', 'shot.png'],
    );
    expect(
      tools.filter((t) => t.action === 'search').map((t) => t.path),
    ).toEqual([null]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Lat commands appear as shell calls]]
  it('records a lat command as a shell call', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(shellCalls(events)[0]).toMatchObject({
      name: 'exec_command',
      path: null,
      shell: { command: 'lat search "token budget"' },
    });
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Bypass reads target the knowledge directory]]
  it('flags shell readers aimed at the lat.md directory only', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(ofKind(events, 'bypass_read')).toMatchObject([
      { path: 'lat.md/cli.md', bytes: 12 },
    ]);
    expect(
      ofKind(await readCommand('grep -rn foo lat.md/ src'), 'bypass_read'),
    ).toMatchObject([{ path: 'lat.md' }]);
    expect(ofKind(await readCommand('cat src/a.ts'), 'bypass_read')).toEqual(
      [],
    );
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Beads claim and close carry issue ids]]
  it('extracts bd claim and close issue ids from positional arguments', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(
      ofKind(events, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([
      ['claim', 'lat-x.1'],
      ['close', 'lat-x.1'],
      ['close', 'lat-x.2'],
    ]);

    const flagged = await readCommand(
      'bd update --status in_progress lat-9 --claim',
    );
    expect(
      ofKind(flagged, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([['claim', 'lat-9']]);
    const failed = await readCommand('bd close lat-9', { exit_code: 1 });
    expect(ofKind(failed, 'bd_command')).toEqual([]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#A command that never ran records only the shell call]]
  it.each(['failed', 'declined'])(
    'records a %s command that never ran as its shell call only',
    async (status) => {
      const script = 'bd close lat-9 && echo x > out.txt && cat lat.md/cli.md';
      const events = await readCommand(script, {
        status,
        exit_code: -1,
        parsed_cmd: [{ type: 'read', path: 'lat.md/cli.md' }],
      });
      expect(toolCalls(events)).toEqual([
        expect.objectContaining({
          action: 'shell',
          shell: {
            command: script,
            exit_code: { value: null, reason: 'not_captured' },
          },
        }),
      ]);
      expect(ofKind(events, 'bd_command')).toEqual([]);
      expect(ofKind(events, 'bypass_read')).toEqual([]);
    },
  );

  // @lat: [[usage-source-codex#Usage Source Codex#Token usage splits the cache]]
  it('reports token usage once per response with the cache split', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);

    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 200,
        output: 50,
        cache_read: 800,
        cache_write: 0,
        reasoning: 20,
      },
      { input: 2000, output: 100, cache_read: 0, cache_write: 0, reasoning: 0 },
    ]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#A counter the transcript leaves out is unknown]]
  it('reports a token counter the record leaves out as null with a reason', async () => {
    const path = writeRollout([
      record('token_usage_record', {
        response_id: 'r-sparse',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
        },
      }),
      record('token_usage_record', {
        response_id: 'r-nocache',
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
    ]);
    const { events } = await codexSource.read(path, null);
    const reason = 'unsupported_by_agent';
    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 100,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning: null,
        unknown_reasons: { reasoning: reason },
      },
      {
        input: null,
        output: 5,
        cache_read: null,
        cache_write: null,
        reasoning: null,
        unknown_reasons: {
          input: reason,
          cache_read: reason,
          cache_write: reason,
          reasoning: reason,
        },
      },
    ]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Shell writes add edit events]]
  it('keeps the shell record beside edits from shell writes', async () => {
    const path = installFixture('main.jsonl', 'rollout-main.jsonl');
    const { events } = await codexSource.read(path, null);
    const redirect = toolCalls(events).filter(
      (t) => t.action === 'edit' && t.name === 'exec_command',
    );
    expect(redirect.map((t) => t.path)).toEqual(['sub/notes.txt']);
    expect(
      shellCalls(events).some(
        (t) => t.shell?.command === 'echo hi > notes.txt',
      ),
    ).toBe(true);

    const copied = await readCommand('cp a.txt lat.md/b.txt && tee out.log');
    expect(
      toolCalls(copied)
        .filter((t) => t.action === 'edit')
        .map((t) => t.path),
    ).toEqual(['lat.md/b.txt', 'out.log']);
    expect(ofKind(copied, 'bypass_read')).toEqual([]);

    const heredoc = await readCommand(
      'git commit -m "$(cat <<\'EOF\'\nfix a > b\nEOF\n)"',
    );
    expect(toolCalls(heredoc).filter((t) => t.action === 'edit')).toEqual([]);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Resume from a checkpoint]]
  it('resumes from a checkpoint without repeating events', async () => {
    installIndex();
    const source = join(FIXTURES, 'main.jsonl');
    const lines = readFileSync(source, 'utf-8').split('\n').filter(Boolean);
    const path = join(home, 'sessions', '2026', '11', '08', 'rollout-r.jsonl');
    writeFileSync(path, lines.slice(0, 10).join('\n') + '\n');

    const first = await codexSource.read(path, null);
    const partial = lines[10].slice(0, 40);
    appendFileSync(path, partial);
    const stalled = await codexSource.read(path, first.checkpoint);
    expect(stalled.checkpoint).toEqual(first.checkpoint);
    expect(stalled.events).toEqual([]);

    writeFileSync(path, lines.join('\n') + '\n');
    const second = await codexSource.read(path, first.checkpoint);
    const full = await codexSource.read(path, null);

    const stable = (events: SessionEvent[]) =>
      events.filter(
        (e) => e.kind !== 'session_end' && e.kind !== 'session_name',
      );
    expect(first.checkpoint.offset).toBeGreaterThan(0);
    expect(second.events.some((e) => e.kind === 'session_start')).toBe(false);
    expect([...stable(first.events), ...stable(second.events)]).toEqual(
      stable(full.events),
    );
    expect(second.checkpoint.offset).toBe(readFileSync(path).length);
    const ids = [...stable(first.events), ...stable(second.events)].map(
      (e) => e.event_id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  // @lat: [[usage-source-codex#Usage Source Codex#Unreadable store returns a reason]]
  it('returns a reason instead of throwing for an unreadable store', async () => {
    const missing = await codexSource.read(join(scratch, 'gone.jsonl'), {
      offset: 5,
    });
    expect(missing).toEqual({
      events: [],
      checkpoint: { offset: 5 },
      reason: 'transcript_expired',
    });
    const directory = await codexSource.read(scratch, null);
    expect(directory).toEqual({
      events: [],
      checkpoint: { offset: 0 },
      reason: 'not_captured',
    });
    process.env.CODEX_HOME = join(scratch, 'no-such-home');
    expect(await codexSource.discover('/work/repo')).toEqual([]);
  });
});
