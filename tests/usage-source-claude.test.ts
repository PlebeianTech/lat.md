import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/fork/usage/schema.js';
import { claudeSource } from '../src/fork/usage/sources/claude.js';
import { addSessionEvent, emptyState } from '../src/fork/usage/state.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'usage', 'claude');
const MAIN = join(FIXTURES, 'main.jsonl');
const SPEC = 'usage-source-claude#Usage Source Claude';

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

let scratch: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'usage-claude-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

let sequence = 0;

function record(type: string, fields: Record<string, unknown>) {
  sequence += 1;
  return {
    type,
    sessionId: 'sess-gen',
    cwd: '/work/repo',
    timestamp: `2026-02-01T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    ...fields,
  };
}

function bashCall(messageId: string, id: string, command: string, extra = {}) {
  return record('assistant', {
    message: {
      id: messageId,
      model: 'model-a',
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command, ...extra } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

function toolResult(id: string, text = 'ok', isError = false) {
  return record('user', {
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: text,
          is_error: isError,
        },
      ],
    },
  });
}

function copyWithCwd(from: string, to: string, cwd: string): void {
  writeFileSync(to, readFileSync(from, 'utf-8').replaceAll('/work/repo', cwd));
}

function writeTranscript(name: string, records: object[]): string {
  const path = join(scratch, name);
  writeFileSync(path, records.map((r) => JSON.stringify(r) + '\n').join(''));
  return path;
}

async function readBash(command: string, extra = {}) {
  const path = writeTranscript('bash.jsonl', [
    bashCall('mb', 'tb', command, extra),
    toolResult('tb'),
  ]);
  return (await claudeSource.read(path, null)).events;
}

describe('claude session reader', () => {
  // @lat: [[usage-source-claude#Usage Source Claude#Discovery finds repo and worktree transcripts]]
  it('discovers main and subagent transcripts for a repo root', async () => {
    const repoRoot = join(scratch, 'repo.one');
    mkdirSync(repoRoot);
    const slug = repoRoot.replace(/[^a-zA-Z0-9]/g, '-');
    const projectDir = join(scratch, 'config', 'projects', slug);
    mkdirSync(join(projectDir, 'sess-main', 'subagents'), { recursive: true });
    copyWithCwd(MAIN, join(projectDir, 'sess-main.jsonl'), repoRoot);
    copyWithCwd(
      join(FIXTURES, 'subagent.jsonl'),
      join(projectDir, 'sess-main', 'subagents', 'agent-a1.jsonl'),
      repoRoot,
    );
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config');

    expect(await claudeSource.discover(repoRoot)).toEqual([
      join(projectDir, 'sess-main.jsonl'),
      join(projectDir, 'sess-main', 'subagents', 'agent-a1.jsonl'),
    ]);
    expect(await claudeSource.discover(join(scratch, 'other'))).toEqual([]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Discovery drops another project's transcripts]]
  it('drops a transcript from a project whose path shares the slug', async () => {
    const repoRoot = join(scratch, 'my-app');
    const otherRoot = join(scratch, 'my.app');
    mkdirSync(repoRoot);
    mkdirSync(otherRoot);
    const slug = repoRoot.replace(/[^a-zA-Z0-9]/g, '-');
    expect(otherRoot.replace(/[^a-zA-Z0-9]/g, '-')).toBe(slug);
    const projectDir = join(scratch, 'config', 'projects', slug);
    mkdirSync(projectDir, { recursive: true });
    copyWithCwd(MAIN, join(projectDir, 'mine.jsonl'), repoRoot);
    copyWithCwd(MAIN, join(projectDir, 'theirs.jsonl'), otherRoot);
    writeFileSync(
      join(projectDir, 'no-cwd.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'no cwd' }) + '\n',
    );
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config');

    expect(await claudeSource.discover(repoRoot)).toEqual([
      join(projectDir, 'mine.jsonl'),
      join(projectDir, 'no-cwd.jsonl'),
    ]);
    expect(await claudeSource.discover(otherRoot)).toEqual([
      join(projectDir, 'no-cwd.jsonl'),
      join(projectDir, 'theirs.jsonl'),
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Discovery closes every transcript it opens]]
  it('leaves no file descriptor open on a transcript larger than one chunk', async () => {
    const repoRoot = join(scratch, 'repo');
    mkdirSync(repoRoot);
    const slug = repoRoot.replace(/[^a-zA-Z0-9]/g, '-');
    const projectDir = join(scratch, 'config', 'projects', slug);
    mkdirSync(projectDir, { recursive: true });
    const first = JSON.stringify({ type: 'user', cwd: repoRoot });
    const filler = JSON.stringify({
      type: 'summary',
      summary: 'x'.repeat(1000),
    });
    writeFileSync(
      join(projectDir, 'big.jsonl'),
      [first, ...Array(200).fill(filler)].join('\n') + '\n',
    );
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config');

    await claudeSource.discover(repoRoot);
    const before = readdirSync('/dev/fd').length;
    for (let i = 0; i < 50; i++) {
      expect(await claudeSource.discover(repoRoot)).toEqual([
        join(projectDir, 'big.jsonl'),
      ]);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(readdirSync('/dev/fd').length).toBeLessThanOrEqual(before);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Subagent events name their parent session]]
  it('sets parent_session_id on subagent events', async () => {
    const { events } = await claudeSource.read(
      join(FIXTURES, 'subagent.jsonl'),
      null,
    );
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.session_id).toBe('agent-a1');
      expect(e.parent_session_id).toBe('sess-main');
    }
    expect(toolCalls(events)).toEqual([
      { name: 'Glob', action: 'search', path: null, bytes: 4 },
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Session lifecycle and name]]
  it('emits session start, name, model and end', async () => {
    const { events, reason } = await claudeSource.read(MAIN, null);
    expect(reason).toBeNull();
    expect(events[0]).toMatchObject({
      kind: 'session_start',
      session_id: 'sess-main',
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(ofKind(events, 'session_name')[0].name).toBe('Fixture session');
    expect(ofKind(events, 'model').map((e) => e.model)).toEqual(['model-a']);
    expect(events.at(-1)).toMatchObject({
      kind: 'session_end',
      ts: '2026-01-01T00:00:04.007Z',
    });
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Edit tools yield edit events]]
  it('maps Edit, Write, MultiEdit and a redirect to edit events', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    const edits = toolCalls(events).filter((t) => t.action === 'edit');
    expect(edits.map((t) => [t.name, t.path])).toEqual([
      ['Edit', 'src/a.ts'],
      ['Write', 'src/b.ts'],
      ['MultiEdit', 'src/c.ts'],
      ['Bash', 'out.txt'],
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Tool paths are worktree relative]]
  it('normalizes paths and maps read and search actions', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    const tools = toolCalls(events);
    expect(tools.filter((t) => t.action === 'read').map((t) => t.path)).toEqual(
      ['lat.md/cli.md', '/elsewhere/x.md'],
    );
    expect(tools.find((t) => t.name === 'Grep')).toMatchObject({
      action: 'search',
      path: 'lat.md',
    });
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell calls carry command and exit code]]
  it('carries shell command and exit code, null when unknown', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    const shells = toolCalls(events).flatMap((t) =>
      t.action === 'shell' ? [t.shell] : [],
    );
    expect(shells.find((s) => s.command === 'pnpm test')?.exit_code).toEqual({
      value: 2,
    });
    expect(shells[0].exit_code).toEqual({ value: 0 });

    const open = join(scratch, 'no-result.jsonl');
    writeFileSync(
      open,
      readFileSync(join(FIXTURES, 'open-tool.jsonl'), 'utf-8') +
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-main',
          timestamp: '2026-01-01T00:03:00.000Z',
          message: { role: 'user', content: 'moved on' },
        }) +
        '\n',
    );
    const orphan = await claudeSource.read(open, null);
    expect(toolCalls(orphan.events)[0]).toMatchObject({
      action: 'shell',
      shell: {
        command: 'sleep 1',
        exit_code: { value: null, reason: 'not_captured' },
      },
    });
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Lat commands appear as shell calls]]
  it('records a lat command as a shell call', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    const commands = toolCalls(events).flatMap((t) =>
      t.action === 'shell' ? [t.shell.command] : [],
    );
    expect(commands).toContain('lat search "fixture query"');
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Bypass reads target the knowledge directory]]
  it('flags reads and greps aimed at the lat.md directory only', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    expect(ofKind(events, 'bypass_read').map((e) => [e.path, e.bytes])).toEqual(
      [
        ['lat.md/cli.md', 12],
        ['lat.md', 4],
      ],
    );

    const glob = writeTranscript('glob.jsonl', [
      record('assistant', {
        message: {
          id: 'm-glob',
          model: 'model-a',
          content: [
            {
              type: 'tool_use',
              id: 'gl1',
              name: 'Glob',
              input: { pattern: '*.md', path: '/work/repo/lat.md' },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      toolResult('gl1', 'lat.md/cli.md'),
    ]);
    const listed = (await claudeSource.read(glob, null)).events;
    expect(toolCalls(listed).map((t) => [t.name, t.path])).toEqual([
      ['Glob', 'lat.md'],
    ]);
    expect(ofKind(listed, 'bypass_read')).toEqual([]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Beads claim and close carry issue ids]]
  it('extracts bd claim and close issue ids', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    expect(
      ofKind(events, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([
      ['claim', 'lat-eah.4'],
      ['close', 'lat-eah.4'],
      ['close', 'lat-eah.5'],
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Token usage splits the cache]]
  it('reports token usage once per message with the cache split', async () => {
    const { events } = await claudeSource.read(MAIN, null);
    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 3,
        output: 40,
        cache_read: 1000,
        cache_write: 200,
        reasoning: 7,
      },
      {
        input: 5,
        output: 60,
        cache_read: 2000,
        cache_write: 0,
        reasoning: null,
        unknown_reasons: { reasoning: 'unsupported_by_agent' },
      },
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#A counter the transcript leaves out is unknown]]
  it('reports a token counter the message leaves out as null with a reason', async () => {
    const path = join(scratch, 'sparse.jsonl');
    const lines = [
      record('user', { message: { role: 'user', content: 'p' } }),
      record('assistant', {
        message: {
          id: 'msparse',
          model: 'model-a',
          content: [{ type: 'text', text: 'x' }],
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }),
      record('system', { subtype: 'stop_hook_summary' }),
    ];
    writeFileSync(path, lines.map((r) => JSON.stringify(r) + '\n').join(''));
    const { events } = await claudeSource.read(path, null);
    expect(ofKind(events, 'token_usage').map((e) => e.usage)).toEqual([
      {
        input: 4,
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

  // @lat: [[usage-source-claude#Usage Source Claude#Resume from a checkpoint]]
  it('resumes from a checkpoint without repeating events', async () => {
    const lines = readFileSync(MAIN, 'utf-8').split('\n').filter(Boolean);
    const path = join(scratch, 'growing.jsonl');
    writeFileSync(path, lines.slice(0, 6).join('\n') + '\n');
    const first = await claudeSource.read(path, null);
    writeFileSync(path, lines.join('\n') + '\n');
    const second = await claudeSource.read(path, first.checkpoint);
    const full = await claudeSource.read(path, null);

    const ids = (r: { events: SessionEvent[] }) =>
      r.events
        .filter((e) => e.kind !== 'session_end' && e.kind !== 'model')
        .map((e) => e.event_id);
    expect(ids(second).filter((id) => ids(first).includes(id))).toEqual([]);
    expect([...ids(first), ...ids(second)].sort()).toEqual(ids(full).sort());

    const again = await claudeSource.read(path, second.checkpoint);
    expect(again.events).toEqual([]);
    expect(again.checkpoint).toEqual(second.checkpoint);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Redirecting shell calls keep their shell record]]
  it('emits shell and edit events for a redirected test run', async () => {
    const events = await readBash('pnpm test > log.txt 2>&1');
    const tools = toolCalls(events);
    expect(tools.map((t) => [t.action, t.path])).toEqual([
      ['shell', null],
      ['edit', 'log.txt'],
    ]);
    expect(tools[0]).toMatchObject({
      shell: { command: 'pnpm test > log.txt 2>&1', exit_code: { value: 0 } },
    });
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Redirecting shell calls keep their shell record]]
  it('flags a bypass read whose output is redirected', async () => {
    const events = await readBash('cat lat.md/x.md > /tmp/y');
    expect(ofKind(events, 'bypass_read').map((e) => e.path)).toEqual([
      'lat.md/x.md',
    ]);
    expect(toolCalls(events).map((t) => t.action)).toEqual(['shell', 'edit']);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Heredoc bodies never invent writes]]
  it('ignores a greater-than inside a heredoc commit message', async () => {
    const command = [
      "git commit -m \"$(cat <<'EOF'",
      'fix: a > b and "quoted" it\'s',
      'EOF',
      ')"',
    ].join('\n');
    const tools = toolCalls(await readBash(command));
    expect(tools.map((t) => t.action)).toEqual(['shell']);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Heredoc bodies never invent writes]]
  it('skips the body of a dash heredoc', async () => {
    const command =
      'cat > notes.txt <<-EOF\n\tbody > ignored.txt\n\tEOF\nbd close lat-9\n';
    const events = await readBash(command);
    expect(
      toolCalls(events)
        .filter((t) => t.action === 'edit')
        .map((t) => t.path),
    ).toEqual(['notes.txt']);
    expect(ofKind(events, 'bd_command').map((e) => e.issue_id)).toEqual([
      'lat-9',
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Beads ids come from positional arguments]]
  it('takes bd ids from positional arguments in any flag order', async () => {
    const close = await readBash('bd close lat-x.1 --reason no-action');
    expect(
      ofKind(close, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([['close', 'lat-x.1']]);
    const claim = await readBash(
      'bd update --status in_progress lat-1 --claim',
    );
    expect(
      ofKind(claim, 'bd_command').map((e) => [e.verb, e.issue_id]),
    ).toEqual([['claim', 'lat-1']]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Background shell calls have no exit code]]
  it('reports a background shell call exit code as not captured', async () => {
    const events = await readBash('pnpm dev', { run_in_background: true });
    expect(toolCalls(events)[0]).toMatchObject({
      shell: { exit_code: { value: null, reason: 'not_captured' } },
    });
  });

  // @lat: [[usage-source-claude#Usage Source Claude#A blocked shell call records only the shell call]]
  it('records a blocked shell call without its bd, edit or bypass events', async () => {
    const command = 'bd close lat-eah.39 > out.txt && cat lat.md/cli.md';
    const path = writeTranscript('blocked.jsonl', [
      bashCall('mx', 'tx', command),
      toolResult('tx', 'PreToolUse:Bash hook error: blocked', true),
    ]);
    const { events } = await claudeSource.read(path, null);
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

  // @lat: [[usage-source-claude#Usage Source Claude#An errored Read or Grep is not a bypass read]]
  it('records an errored Read or Grep without a bypass read', async () => {
    const call = (id: string, name: string, input: object) =>
      record('assistant', {
        message: {
          id: `m-${id}`,
          model: 'model-a',
          content: [{ type: 'tool_use', id, name, input }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    const path = writeTranscript('read-error.jsonl', [
      call('r1', 'Read', { file_path: '/work/repo/lat.md/cli.md' }),
      toolResult('r1', 'PreToolUse:Read hook error: blocked', true),
      call('g1', 'Grep', { pattern: 'x', path: '/work/repo/lat.md' }),
      toolResult('g1', 'Permission denied', true),
    ]);
    const { events } = await claudeSource.read(path, null);
    expect(toolCalls(events).map((t) => t.name)).toEqual(['Read', 'Grep']);
    expect(ofKind(events, 'bypass_read')).toEqual([]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#A failed edit is not an edit]]
  it('records no edit for an Edit or Write whose result is an error', async () => {
    const call = (id: string, name: string, input: object) =>
      record('assistant', {
        message: {
          id: `m-${id}`,
          model: 'model-a',
          content: [{ type: 'tool_use', id, name, input }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    const path = writeTranscript('edit-error.jsonl', [
      call('e1', 'Edit', { file_path: '/work/repo/src/a.ts' }),
      toolResult('e1', 'String to replace not found in file.', true),
      call('w1', 'Write', { file_path: '/work/repo/src/b.ts' }),
      toolResult('w1', 'Permission denied', true),
      call('e2', 'Edit', { file_path: '/work/repo/src/c.ts' }),
      toolResult('e2', 'ok'),
    ]);
    const { events } = await claudeSource.read(path, null);
    expect(toolCalls(events).map((t) => t.path)).toEqual(['src/c.ts']);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Message groups are never split]]
  it('counts one token usage for a message split across reads', async () => {
    const usage = { input_tokens: 4, output_tokens: 9 };
    const part = (kind: string) =>
      record('assistant', {
        message: {
          id: 'msplit',
          model: 'model-a',
          content: [{ type: kind, thinking: '', text: 'x' }],
          usage,
        },
      });
    const path = join(scratch, 'straddle.jsonl');
    const first = [
      record('user', { message: { role: 'user', content: 'p' } }),
      part('thinking'),
    ];
    writeFileSync(path, first.map((r) => JSON.stringify(r) + '\n').join(''));
    const before = await claudeSource.read(path, null);
    expect(ofKind(before.events, 'token_usage')).toEqual([]);

    const rest = [
      part('text'),
      record('system', { subtype: 'stop_hook_summary' }),
    ];
    writeFileSync(
      path,
      [...first, ...rest].map((r) => JSON.stringify(r) + '\n').join(''),
    );
    const after = await claudeSource.read(path, before.checkpoint);
    expect(ofKind(after.events, 'token_usage')).toHaveLength(1);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Message groups are never split]]
  it('counts one token usage when parallel tool calls straddle reads', async () => {
    const call = (id: string) =>
      record('assistant', {
        message: {
          id: 'mpar',
          model: 'model-a',
          content: [
            { type: 'tool_use', id, name: 'Bash', input: { command: 'true' } },
          ],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      });
    const head = [
      record('user', { message: { role: 'user', content: 'p' } }),
      call('pa'),
      call('pb'),
      toolResult('pa'),
    ];
    const path = writeTranscript('parallel.jsonl', head);
    const before = await claudeSource.read(path, null);
    const tail = [toolResult('pb'), record('system', { subtype: 'stop' })];
    writeTranscript('parallel.jsonl', [...head, ...tail]);
    const after = await claudeSource.read(path, before.checkpoint);
    const usages = ofKind([...before.events, ...after.events], 'token_usage');
    expect(usages).toHaveLength(1);
    expect(toolCalls(after.events)).toHaveLength(2);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Message groups are never split]]
  it('keeps one token usage when a read stops between parts of a message', async () => {
    const call = (id: string) =>
      record('assistant', {
        message: {
          id: 'mgap',
          model: 'model-a',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id, name: 'Bash', input: { command: 'true' } },
          ],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      });
    const head = [call('ga'), toolResult('ga')];
    const path = writeTranscript('gap.jsonl', head);
    const before = await claudeSource.read(path, null);
    writeTranscript('gap.jsonl', [...head, call('gb'), toolResult('gb')]);
    const after = await claudeSource.read(path, before.checkpoint);

    const state = emptyState();
    for (const event of [...before.events, ...after.events])
      addSessionEvent(state, 'claude', event);
    const kept = Object.values(state.sessions).filter(
      (s) => s.event.kind === 'token_usage',
    );
    expect(kept).toHaveLength(1);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Message groups are never split]]
  it('takes token usage from the last line of a message', async () => {
    const part = (kind: string, output: number) =>
      record('assistant', {
        message: {
          id: 'mfinal',
          model: 'model-a',
          stop_reason: 'end_turn',
          content: [{ type: kind, thinking: '', text: 'x' }],
          usage: { input_tokens: 4, output_tokens: output },
        },
      });
    const path = writeTranscript('final.jsonl', [
      record('user', { message: { role: 'user', content: 'p' } }),
      part('thinking', 5),
      part('text', 253),
    ]);
    const usages = ofKind(
      (await claudeSource.read(path, null)).events,
      'token_usage',
    );
    expect(usages.map((e) => e.usage.output)).toEqual([253]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Message groups are never split]]
  it('replaces a partial token usage when a later read sees the message end', async () => {
    const call = (id: string, output: number, timestamp: string) => ({
      ...record('assistant', {
        message: {
          id: 'msplit',
          model: 'model-a',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id, name: 'Bash', input: { command: 'true' } },
          ],
          usage: { input_tokens: 2, output_tokens: output },
        },
      }),
      timestamp,
    });
    const head = [
      call('sa', 5, '2026-03-01T00:00:01.000Z'),
      { ...toolResult('sa'), timestamp: '2026-03-01T00:00:02.000Z' },
    ];
    const path = writeTranscript('split.jsonl', head);
    const before = await claudeSource.read(path, null);
    writeTranscript('split.jsonl', [
      ...head,
      call('sb', 253, '2026-03-01T00:00:03.000Z'),
      { ...toolResult('sb'), timestamp: '2026-03-01T00:00:04.000Z' },
    ]);
    const after = await claudeSource.read(path, before.checkpoint);

    const state = emptyState();
    for (const event of [...before.events, ...after.events])
      addSessionEvent(state, 'claude', event);
    const kept = Object.values(state.sessions)
      .map((s) => s.event)
      .filter((e) => e.kind === 'token_usage');
    expect(kept.map((e) => e.usage.output)).toEqual([253]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Session lifecycle and name]]
  it('starts a session at its first real timestamp, never 1970', async () => {
    const untimed = { type: 'mode', sessionId: 'sess-gen', mode: 'default' };
    const path = writeTranscript('untimed.jsonl', [untimed]);
    const early = await claudeSource.read(path, null);
    expect(early.events).toEqual([]);
    expect(early.checkpoint.offset).toBe(0);

    writeTranscript('untimed.jsonl', [
      untimed,
      {
        ...record('user', { message: { role: 'user', content: 'p' } }),
        timestamp: '2026-03-02T00:00:00.000Z',
      },
    ]);
    const later = await claudeSource.read(path, early.checkpoint);
    const starts = ofKind(later.events, 'session_start');
    expect(starts.map((e) => e.ts)).toEqual(['2026-03-02T00:00:00.000Z']);
    for (const event of later.events)
      expect(event.ts).toBe('2026-03-02T00:00:00.000Z');
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Message groups are never split]]
  it('emits a finished last message that nothing follows', async () => {
    const part = (kind: string) =>
      record('assistant', {
        message: {
          id: 'mdone',
          model: 'model-a',
          stop_reason: 'end_turn',
          content: [{ type: kind, thinking: '', text: 'x' }],
          usage: { input_tokens: 4, output_tokens: 9 },
        },
      });
    const path = writeTranscript('finished.jsonl', [
      record('user', { message: { role: 'user', content: 'p' } }),
      record('api-request', {}),
      part('thinking'),
      part('text'),
    ]);
    const result = await claudeSource.read(path, null);
    expect(ofKind(result.events, 'token_usage')).toHaveLength(1);
    expect(result.checkpoint.offset).toBe(readFileSync(path).length);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Copied history counts once]]
  it('counts token usage and tool calls once when a subagent copies history', async () => {
    const history = [
      bashCall('mcopy', 'tcopy', 'bd close lat-9'),
      toolResult('tcopy'),
    ];
    const original = writeTranscript(
      'agent-a.jsonl',
      history.map((r) => ({ ...r, agentId: 'a' })),
    );
    const copy = writeTranscript(
      'agent-b.jsonl',
      [...history, bashCall('mown', 'town', 'true'), toolResult('town')].map(
        (r) => ({ ...r, agentId: 'b' }),
      ),
    );

    const state = emptyState();
    for (const path of [original, copy])
      for (const event of (await claudeSource.read(path, null)).events)
        addSessionEvent(state, 'claude', event);
    const kinds = Object.values(state.sessions).map((s) => s.event.kind);
    const count = (kind: string) => kinds.filter((k) => k === kind).length;
    expect(count('token_usage')).toBe(2);
    expect(count('tool_call')).toBe(2);
    expect(count('bd_command')).toBe(1);
    expect(count('session_start')).toBe(2);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Heredoc bodies never invent writes]]
  it('does not read a here-string in a substitution as a heredoc', async () => {
    const command = 'echo "$(cat <<<"x")" > out.txt\nbd close lat-7';
    const events = await readBash(command);
    expect(
      toolCalls(events)
        .filter((t) => t.action === 'edit')
        .map((t) => t.path),
    ).toEqual(['out.txt']);
    expect(ofKind(events, 'bd_command').map((e) => e.issue_id)).toEqual([
      'lat-7',
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Unfinished tool calls wait for their result]]
  it('holds back a tool call that has no result yet', async () => {
    const open = join(FIXTURES, 'open-tool.jsonl');
    const result = await claudeSource.read(open, null);
    expect(toolCalls(result.events)).toEqual([]);
    const firstLineBytes = Buffer.byteLength(
      readFileSync(open, 'utf-8').split('\n')[0] + '\n',
    );
    expect(result.checkpoint.offset).toBe(firstLineBytes);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Unreadable store returns a reason]]
  it('returns a reason instead of throwing for an unreadable store', async () => {
    const missing = await claudeSource.read(join(scratch, 'gone.jsonl'), {
      offset: 5,
    });
    expect(missing).toEqual({
      events: [],
      checkpoint: { offset: 5 },
      reason: 'transcript_expired',
    });
    const directory = await claudeSource.read(scratch, null);
    expect(directory).toEqual({
      events: [],
      checkpoint: { offset: 0 },
      reason: 'not_captured',
    });
  });
});
