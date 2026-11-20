import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syncLatHooks } from '../src/cli/init.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'dist', 'src', 'cli', 'index.js');
const GUARD = join(REPO_ROOT, 'hooks', 'lat-guard.sh');

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'lat-read-ref-hook-'));
  projects.push(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  mkdirSync(join(project, 'src'));
  writeFileSync(
    join(project, 'src', 'feature.ts'),
    [
      'export const a = 1;',
      '// @lat: [[cli#hook#PostToolUse]]',
      'export const b = 2;',
    ].join('\n'),
  );
  writeFileSync(join(project, 'src', 'plain.ts'), 'export const c = 3;\n');
  return project;
}

function runReadHook(project: string, stdin: string) {
  return spawnSync('node', [CLI, 'hook', 'claude', 'PostToolUse'], {
    cwd: project,
    encoding: 'utf-8',
    input: stdin,
  });
}

function readPayload(
  filePath: string,
  sessionId: string,
  range: { offset?: number; limit?: number } = {},
): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath, ...range },
  });
}

describe('Claude Code Read hook', () => {
  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#A Read of referenced lines prints advice]]
  it('prints PostToolUse advice for a Read of lines with references', () => {
    const project = makeProject();
    const result = runReadHook(
      project,
      readPayload(join(project, 'src', 'feature.ts'), randomUUID()),
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'lat section "cli#hook#PostToolUse"',
    );
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#The Read range comes from offset and limit]]
  it('prints nothing when offset and limit exclude the reference', () => {
    const project = makeProject();
    const result = runReadHook(
      project,
      readPayload(join(project, 'src', 'feature.ts'), randomUUID(), {
        offset: 3,
        limit: 1,
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#A repeated Read in the same session prints nothing]]
  it('prints nothing for the same Read again in the same session', () => {
    const project = makeProject();
    const payload = readPayload(
      join(project, 'src', 'feature.ts'),
      randomUUID(),
    );
    runReadHook(project, payload);
    const result = runReadHook(project, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#A Read without references prints nothing]]
  it('prints nothing for a Read of a file without references', () => {
    const project = makeProject();
    const result = runReadHook(
      project,
      readPayload(join(project, 'src', 'plain.ts'), randomUUID()),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#Malformed input prints nothing]]
  it('prints nothing and exits 0 for malformed JSON', () => {
    const project = makeProject();
    const result = runReadHook(project, '{not json');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('Read hook wiring', () => {
  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#lat init adds a Read entry for Claude Code]]
  it('adds a Read entry for Claude Code and keeps the Edit entry', () => {
    const project = makeProject();
    const settingsPath = join(project, '.claude', 'settings.json');
    syncLatHooks(settingsPath, 'global', 'claude', project);

    const postToolUse = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks
      .PostToolUse;
    expect(postToolUse).toEqual([
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [{ type: 'command', command: 'lat hook claude PostToolUse' }],
      },
      {
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'lat hook claude PostToolUse' }],
      },
    ]);
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#lat init for Codex is unchanged]]
  it('writes the same Codex hooks file as before', () => {
    const project = makeProject();
    const hooksPath = join(project, '.codex', 'hooks.json');
    syncLatHooks(hooksPath, 'global', 'codex', project);

    const command = (event: string) => ({
      hooks: [{ type: 'command', command: `lat hook codex ${event}` }],
    });
    expect(JSON.parse(readFileSync(hooksPath, 'utf8'))).toEqual({
      hooks: {
        UserPromptSubmit: [command('UserPromptSubmit')],
        Stop: [command('Stop')],
        PostToolUse: [
          { matcher: 'Edit|Write|MultiEdit', ...command('PostToolUse') },
        ],
      },
    });
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#The plugin has a Read entry without the index fix]]
  it('has a plugin Read entry that does not fix the index', () => {
    const plugin = JSON.parse(
      readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'),
    );
    const readEntries = plugin.hooks.PostToolUse.filter(
      (entry: { matcher?: string }) => entry.matcher === 'Read',
    );

    expect(readEntries).toEqual([
      {
        matcher: 'Read',
        hooks: [
          {
            type: 'command',
            command:
              'sh "${CLAUDE_PLUGIN_ROOT}/hooks/lat-guard.sh" hook claude PostToolUse',
            timeout: 10,
          },
        ],
      },
    ]);
  });

  // @lat: [[fork-read-ref-hooks#Fork Read Ref Hooks#The plugin defers to a project that ran lat init]]
  it('lat-guard.sh prints nothing for a Read when the project registers PostToolUse', () => {
    const project = makeProject();
    mkdirSync(join(project, 'lat.md'));
    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Edit|Write|MultiEdit',
              hooks: [
                { type: 'command', command: 'lat hook claude PostToolUse' },
              ],
            },
          ],
        },
      }),
    );
    const env = { ...process.env };
    delete env.LAT_DISABLE;

    const result = spawnSync(
      'sh',
      [GUARD, 'hook', 'claude', 'PostToolUse'],
      {
        cwd: project,
        encoding: 'utf-8',
        input: readPayload(join(project, 'src', 'feature.ts'), randomUUID()),
        env: {
          ...env,
          CLAUDE_PLUGIN_ROOT: REPO_ROOT,
          CLAUDE_PROJECT_DIR: project,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
