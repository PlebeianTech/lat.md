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
import { piSource } from '../src/fork/usage/sources/pi.js';

const FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'usage',
  'pi',
  'main.jsonl',
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
let agentDir: string;
let slugDir: string;
const savedDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'usage-pi-')));
  agentDir = join(scratch, 'agent');
  slugDir = join(agentDir, 'sessions', '--work-repo--');
  mkdirSync(slugDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedDir;
});

function installFixture(name = 'main.jsonl'): string {
  const target = join(slugDir, name);
  cpSync(FIXTURE, target);
  return target;
}

let sequence = 0;

function header(cwd: string) {
  return {
    type: 'session',
    version: 3,
    id: 'pi-gen',
    timestamp: '2026-11-08T11:00:00.000Z',
    cwd,
  };
}

function message(role: string, extra: object) {
  sequence += 1;
  return {
    type: 'message',
    id: `g${sequence}`,
    parentId: null,
    timestamp: `2026-11-08T11:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    message: { role, ...extra },
  };
}

function bashTurn(command: string, text = 'ok', isError = false) {
  const id = `c${++sequence}`;
  return [
    message('assistant', {
      content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
      model: 'model-a',
    }),
    message('toolResult', {
      toolCallId: id,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError,
    }),
  ];
}

function writeSession(
  records: object[],
  name = 'gen.jsonl',
  cwd = '/work/repo',
): string {
  const path = join(slugDir, name);
  writeFileSync(
    path,
    [header(cwd), ...records].map((r) => JSON.stringify(r) + '\n').join(''),
  );
  return path;
}

async function readCommand(command: string, text = 'ok', isError = false) {
  const path = writeSession(bashTurn(command, text, isError));
  return (await piSource.read(path, null)).events;
}

function toolTurn(name: string, args: object, text: string, isError: boolean) {
  const id = `c${++sequence}`;
  return [
    message('assistant', {
      content: [{ type: 'toolCall', id, name, arguments: args }],
      model: 'model-a',
    }),
    message('toolResult', {
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text }],
      isError,
    }),
  ];
}

describe('pi session reader', () => {
  // @lat: [[usage-source-pi#Usage Source pi#An errored read or grep is not a bypass read]]
  it('records an errored read or grep without a bypass read', async () => {
    const path = writeSession([
      ...toolTurn('read', { path: 'lat.md/cli.md' }, 'ENOENT', true),
      ...toolTurn('grep', { pattern: 'x', path: 'lat.md' }, 'denied', true),
    ]);
    const { events } = await piSource.read(path, null);
    expect(toolCalls(events).map((t) => t.name)).toEqual(['read', 'grep']);
    expect(ofKind(events, 'bypass_read')).toEqual([]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#A failed edit is not an edit]]
  it('records no edit for an edit or write whose result is an error', async () => {
    const path = writeSession([
      ...toolTurn(
        'edit',
        { path: 'src/a.ts' },
        'Could not find the exact text in src/a.ts.',
        true,
      ),
      ...toolTurn('write', { path: 'src/b.ts' }, 'EACCES', true),
      ...toolTurn('edit', { path: 'src/c.ts' }, 'ok', false),
    ]);
    const { events } = await piSource.read(path, null);
    expect(toolCalls(events).map((t) => t.path)).toEqual(['src/c.ts']);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Discovery matches sessions by working directory]]
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

    const inRepo = writeSession([], 'a.jsonl', join(repoRoot, 'src'));
    const inWorktree = writeSession([], 'b.jsonl', worktree);
    writeSession([], 'c.jsonl', join(scratch, 'elsewhere'));
    writeFileSync(join(slugDir, 'd.jsonl'), 'not json\n');
    writeFileSync(join(slugDir, 'notes.txt'), JSON.stringify(header(repoRoot)));

    expect(await piSource.discover(repoRoot)).toEqual(
      [inRepo, inWorktree].sort(),
    );
    expect(await piSource.discover(join(scratch, 'none'))).toEqual([]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Session lifecycle, name and model]]
  it('emits session start, name, models and end', async () => {
    const { events } = await piSource.read(installFixture(), null);

    expect(events[0].kind).toBe('session_start');
    expect(events[0].session_id).toBe('pi-sess-0001');
    expect(events[0].ts).toBe('2026-11-08T10:00:00.000Z');
    expect(ofKind(events, 'session_name').map((e) => e.name)).toEqual([
      'Synthetic pi session',
    ]);
    expect(ofKind(events, 'model').map((e) => e.model)).toEqual([
      'model-a',
      'model-b',
    ]);
    const end = ofKind(events, 'session_end');
    expect(end).toHaveLength(1);
    expect(end[0].ts).toBe('2026-11-08T10:00:30.000Z');
    for (const event of events)
      expect('parent_session_id' in event).toBe(false);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Edit and write tools yield edit events]]
  it('yields an edit for write and edit calls, relative to the worktree', async () => {
    const { events } = await piSource.read(installFixture(), null);

    expect(
      toolCalls(events)
        .filter((t) => t.name === 'write' || t.name === 'edit')
        .map((t) => [t.name, t.action, t.path]),
    ).toEqual([
      ['write', 'edit', 'src/new.ts'],
      ['edit', 'edit', 'src/a.ts'],
      ['edit', 'edit', '/other/z.txt'],
    ]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Shell calls carry command and exit code]]
  it('carries shell command and exit code, null when unknown', async () => {
    const { events } = await piSource.read(installFixture(), null);
    const byCommand = new Map(
      shellCalls(events).map((t) => [t.shell?.command, t.shell?.exit_code]),
    );

    expect(byCommand.get('lat search "token budget"')).toEqual({ value: 0 });
    expect(byCommand.get('pnpm test')).toEqual({ value: 2 });
    expect(byCommand.get('sleep 100')).toEqual({
      value: null,
      reason: 'not_captured',
    });
    expect(byCommand.get('bd update lat-x.1 --claim')).toEqual({ value: 0 });

    const aborted = await readCommand('x', 'out\n\nCommand aborted', true);
    expect(shellCalls(aborted)[0].shell?.exit_code).toEqual({
      value: null,
      reason: 'not_captured',
    });
  });

  // @lat: [[usage-source-pi#Usage Source pi#A blocked shell call records only the shell call]]
  it('records a blocked shell call without its bd, edit or bypass events', async () => {
    const command = 'bd close lat-eah.39 > out.txt && cat lat.md/cli.md';
    const events = await readCommand(command, 'blocked by hook', true);
    expect(toolCalls(events)).toEqual([
      expect.objectContaining({
        action: 'shell',
        shell: {
          command,
          exit_code: { value: null, reason: 'not_captured' },
        },
      }),
    ]);
    expect(ofKind(events, 'bd_command')).toEqual([]);
    expect(ofKind(events, 'bypass_read')).toEqual([]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Reads and extension tools]]
  it('maps read calls to reads and ignores extension tools', async () => {
    const { events } = await piSource.read(installFixture(), null);
    const tools = toolCalls(events);

    expect(tools.filter((t) => t.action === 'read').map((t) => t.path)).toEqual(
      ['lat.md/cli.md', 'src/a.ts'],
    );
    expect(tools.some((t) => t.name === 'lat_search')).toBe(false);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Grep find and ls are searches]]
  it('maps grep, find and ls to searches with normalized targets', async () => {
    const { events } = await piSource.read(installFixture(), null);

    expect(
      toolCalls(events)
        .filter((t) => ['grep', 'find', 'ls'].includes(t.name))
        .map((t) => [t.name, t.action, t.path]),
    ).toEqual([
      ['grep', 'search', 'lat.md'],
      ['find', 'search', 'src'],
      ['ls', 'search', '/other/dir'],
      ['grep', 'search', null],
    ]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Lat commands appear as shell calls]]
  it('records a lat command as a shell call', async () => {
    const { events } = await piSource.read(installFixture(), null);

    expect(shellCalls(events)[0]).toMatchObject({
      name: 'bash',
      path: null,
      bytes: 7,
      shell: { command: 'lat search "token budget"' },
    });
  });

  // @lat: [[usage-source-pi#Usage Source pi#Bypass reads target the knowledge directory]]
  it('flags reads and shell readers aimed at the lat.md directory only', async () => {
    const { events } = await piSource.read(installFixture(), null);

    expect(ofKind(events, 'bypass_read')).toMatchObject([
      { path: 'lat.md/cli.md', bytes: 12 },
      { path: 'lat.md', bytes: 3 },
      { path: 'lat.md', bytes: 2 },
    ]);
    expect(ofKind(await readCommand('cat src/a.ts'), 'bypass_read')).toEqual(
      [],
    );
  });

  // @lat: [[usage-source-pi#Usage Source pi#Beads claim and close carry issue ids]]
  it('extracts bd claim and close issue ids from positional arguments', async () => {
    const { events } = await piSource.read(installFixture(), null);

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
    const failed = await readCommand(
      'bd close lat-9',
      'x\n\nCommand exited with code 1',
      true,
    );
    expect(ofKind(failed, 'bd_command')).toEqual([]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#Token usage splits the cache]]
  it('reports token usage once per message with the cache split', async () => {
    const { events } = await piSource.read(installFixture(), null);

    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 200,
        output: 50,
        cache_read: 800,
        cache_write: 30,
        reasoning: 20,
        reported_cost_usd: 0.01,
      },
      {
        input: 10,
        output: 5,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        reported_cost_usd: 0.002,
      },
      {
        input: 300,
        output: 40,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        reported_cost_usd: 0.03,
      },
      {
        input: 5,
        output: 5,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        reported_cost_usd: 0,
      },
      {
        input: 1,
        output: 1,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        reported_cost_usd: 0,
      },
      {
        input: 70,
        output: 9,
        cache_read: 0,
        cache_write: 0,
        reasoning: 3,
        reported_cost_usd: 0.005,
      },
      {
        input: 11,
        output: 22,
        cache_read: 33,
        cache_write: 0,
        reasoning: 0,
        reported_cost_usd: 0.001,
      },
    ]);
  });

  // @lat: [[usage-source-pi#Usage Source pi#A counter the transcript leaves out is unknown]]
  it('reports a token counter the message leaves out as null with a reason', async () => {
    const path = writeSession([
      message('assistant', {
        content: [{ type: 'text', text: 'hi' }],
        model: 'model-a',
        usage: { input: 10, output: 0 },
      }),
      message('user', { content: [{ type: 'text', text: 'next' }] }),
    ]);
    const { events } = await piSource.read(path, null);
    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 10,
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

  // @lat: [[usage-source-pi#Usage Source pi#Shell writes add edit events]]
  it('keeps the shell record beside edits from shell writes', async () => {
    const { events } = await piSource.read(installFixture(), null);
    const redirect = toolCalls(events).filter(
      (t) => t.action === 'edit' && t.name === 'bash',
    );
    expect(redirect.map((t) => t.path)).toEqual(['notes.txt']);
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
  });

  // @lat: [[usage-source-pi#Usage Source pi#Resume from a checkpoint]]
  it('resumes from a checkpoint without repeating events', async () => {
    const lines = readFileSync(FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const path = join(slugDir, 'r.jsonl');
    const bytesOf = (count: number) =>
      Buffer.byteLength(lines.slice(0, count).join('\n') + '\n');

    writeFileSync(path, lines.slice(0, 7).join('\n') + '\n');
    const held = await piSource.read(path, null);
    expect(ofKind(held.events, 'token_usage')).toEqual([]);
    expect(held.checkpoint.offset).toBe(bytesOf(4));

    writeFileSync(path, lines.slice(0, 12).join('\n') + '\n');
    const first = await piSource.read(path, null);
    expect(first.checkpoint.offset).toBe(bytesOf(12));
    appendFileSync(path, lines[12].slice(0, 40));
    const stalled = await piSource.read(path, first.checkpoint);
    expect(stalled.checkpoint).toEqual(first.checkpoint);
    expect(stalled.events).toEqual([]);

    writeFileSync(path, lines.join('\n') + '\n');
    const second = await piSource.read(path, first.checkpoint);
    const full = await piSource.read(path, null);

    const stable = (events: SessionEvent[]) =>
      events.filter(
        (e) =>
          e.kind !== 'session_end' &&
          e.kind !== 'session_name' &&
          e.kind !== 'model',
      );
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

  // @lat: [[usage-source-pi#Usage Source pi#A forked session repeats the copied event ids]]
  it('gives copied entries in a forked session the same event ids', async () => {
    const original = installFixture();
    const lines = readFileSync(FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const forkHeader = {
      ...JSON.parse(lines[0]),
      id: 'pi-fork',
      timestamp: '2026-11-09T00:00:00.000Z',
      parentSession: original,
    };
    const forked = join(slugDir, 'fork.jsonl');
    writeFileSync(
      forked,
      [JSON.stringify(forkHeader), ...lines.slice(1)].join('\n') + '\n',
    );

    const counted = (events: SessionEvent[]) =>
      events
        .filter((e) =>
          ['token_usage', 'tool_call', 'bypass_read', 'bd_command'].includes(
            e.kind,
          ),
        )
        .map((e) => e.event_id);
    const perSession = (events: SessionEvent[]) =>
      events
        .filter((e) => e.kind === 'session_start' || e.kind === 'session_end')
        .map((e) => e.event_id);
    const a = (await piSource.read(original, null)).events;
    const b = (await piSource.read(forked, null)).events;

    expect(counted(a).length).toBeGreaterThan(0);
    expect(new Set(counted(a)).size).toBe(counted(a).length);
    expect(counted(b)).toEqual(counted(a));
    expect(perSession(b)).not.toEqual(perSession(a));
  });

  // @lat: [[usage-source-pi#Usage Source pi#Unreadable store returns a reason]]
  it('returns a reason instead of throwing for an unreadable store', async () => {
    const missing = await piSource.read(join(scratch, 'gone.jsonl'), {
      offset: 5,
    });
    expect(missing).toEqual({
      events: [],
      checkpoint: { offset: 5 },
      reason: 'transcript_expired',
    });
    const directory = await piSource.read(scratch, null);
    expect(directory).toEqual({
      events: [],
      checkpoint: { offset: 0 },
      reason: 'not_captured',
    });
    process.env.PI_CODING_AGENT_DIR = join(scratch, 'no-such-agent');
    expect(await piSource.discover('/work/repo')).toEqual([]);
  });
});
