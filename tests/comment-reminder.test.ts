import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rmDirBestEffort } from './util.js';
import { computeCommentReminder } from '../src/cli/comment-reminder.js';
import { chmodSync } from 'node:fs';

const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

function runPostToolUse(
  agent: 'claude' | 'codex',
  caseDir: string,
  toolInput: Record<string, unknown>,
  opts: { sessionId?: string; toolName?: string } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const stdinJson = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: opts.sessionId ?? randomUUID(),
    cwd: caseDir,
    tool_name: opts.toolName ?? 'Write',
    tool_input: toolInput,
  });

  const result = spawnSync('node', [cliPath, 'hook', agent, 'PostToolUse'], {
    cwd: caseDir,
    encoding: 'utf-8',
    input: stdinJson,
    env: process.env as Record<string, string>,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'lat-comment-reminder-'));
  mkdirSync(join(projectDir, 'lat.md'), { recursive: true });
  writeFileSync(
    join(projectDir, 'lat.md', 'lat.md'),
    '# Project\n\nRoot lat.md file so this dir counts as a lat.md/ tree.\n',
  );
});

afterEach(() => {
  rmDirBestEffort(projectDir);
});

describe('hook PostToolUse comment reminder', () => {
  // @lat: [[comment-reminder#Bare fact comments stay quiet]]
  it('stays quiet for a bare fact comment', () => {
    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: join(projectDir, 'counter.ts'),
      content: '// increment the counter\ncount += 1;\n',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // @lat: [[comment-reminder#Multi-line rationale comment fires once]]
  it('fires once for a multi-line rationale comment', () => {
    const filePath = join(projectDir, 'widget.ts');
    const content = [
      '// We retry three times here because the upstream API is flaky under',
      '// load, and a single failure would otherwise cascade into a user-',
      '// visible error even though the request usually succeeds on retry.',
      'export const RETRIES = 3;',
      '',
    ].join('\n');

    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: filePath,
      content,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      '@lat: [[section-id]]',
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain('widget.ts');
  });

  // @lat: [[comment-reminder#Does not fire twice for the same file in one session]]
  it('does not fire twice for the same file in the same session', () => {
    const filePath = join(projectDir, 'widget2.ts');
    const content = [
      '// This exists because the upstream API is flaky under load and a',
      '// single failure would otherwise cascade into a user-visible error.',
      'export const RETRIES = 3;',
    ].join('\n');
    const sessionId = randomUUID();

    const first = runPostToolUse(
      'claude',
      projectDir,
      { file_path: filePath, content },
      { sessionId },
    );
    expect(JSON.parse(first.stdout).hookSpecificOutput).toBeTruthy();

    const second = runPostToolUse(
      'claude',
      projectDir,
      { file_path: filePath, content },
      { sessionId },
    );
    expect(second.stdout).toBe('');
    expect(second.exitCode).toBe(0);
  });

  // @lat: [[comment-reminder#Exits 0 on a malformed payload]]
  it('exits 0 even on a malformed payload', () => {
    const result = spawnSync(
      'node',
      [cliPath, 'hook', 'claude', 'PostToolUse'],
      {
        cwd: projectDir,
        encoding: 'utf-8',
        input: 'not json',
        env: process.env as Record<string, string>,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout ?? '').toBe('');
  });

  // @lat: [[comment-reminder#Stays quiet for a comment that already carries a ref]]
  it('stays quiet for a comment that already carries a ref', () => {
    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: join(projectDir, 'widget3.ts'),
      content:
        '// @lat: [[widgets#Retry policy]]\n// retries three times because of upstream flakiness\nexport const RETRIES = 3;\n',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // @lat: [[comment-reminder#Stays quiet for decoration with no alphanumeric characters]]
  it('stays quiet for decoration with no alphanumeric characters', () => {
    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: join(projectDir, 'widget4.ts'),
      content: '// ------------------------\n// //////\nexport const X = 1;\n',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // @lat: [[comment-reminder#Stays quiet for linter pragmas]]
  it('stays quiet for linter pragmas', () => {
    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: join(projectDir, 'widget5.ts'),
      content: '// eslint-disable-next-line no-console\nconsole.log("x");\n',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // @lat: [[comment-reminder#Stays quiet for .md files]]
  it('stays quiet for .md files', () => {
    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: join(projectDir, 'notes.md'),
      content:
        '<!-- this explains a long rationale for something important -->\n',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // @lat: [[comment-reminder#Matches basenames with no extension]]
  it('matches basenames with no extension (Dockerfile, Makefile, Rakefile)', () => {
    for (const base of ['Dockerfile', 'Makefile', 'Rakefile']) {
      const { stdout } = runPostToolUse('claude', projectDir, {
        file_path: join(projectDir, base),
        content:
          '# We pin this base image because newer releases dropped a syscall\n# our sandbox depends on, and upgrading silently broke CI twice.\nFROM node:20\n',
      });
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain(
        base,
      );
    }
  });

  // @lat: [[comment-reminder#Does not treat a pointer dereference as a comment]]
  it('does not treat a pointer dereference as a comment', () => {
    const { stdout, exitCode } = runPostToolUse('claude', projectDir, {
      file_path: join(projectDir, 'ptr.c'),
      content: '*count += 1;\n*out = value;\n',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // @lat: [[comment-reminder#Asks for the tree when the project has none yet]]
  it('asks for the tree when the project has none yet', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'lat-comment-reminder-bare-'));
    try {
      const { stdout } = runPostToolUse('claude', bareDir, {
        file_path: join(bareDir, 'widget6.ts'),
        content:
          '// This exists because the upstream API is flaky under load and a\n// single failure would otherwise cascade into a user-visible error.\nexport const RETRIES = 3;\n',
      });
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain(
        'no lat.md/ tree yet',
      );
    } finally {
      rmDirBestEffort(bareDir);
    }
  });

  // @lat: [[comment-reminder#Works the same for the Codex agent]]
  it('works the same for the codex agent', () => {
    const { stdout, exitCode } = runPostToolUse('codex', projectDir, {
      file_path: join(projectDir, 'widget7.ts'),
      content:
        '// This exists because the upstream API is flaky under load and a\n// single failure would otherwise cascade into a user-visible error.\nexport const RETRIES = 3;\n',
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe(
      'PostToolUse',
    );
  });
});

// Cursor's postToolUse payload uses different key names and a different output
// envelope from Claude's. The dispatcher normalizes rather than teaching
// computeCommentReminder a second dialect, so this covers that seam.
describe('cursor postToolUse dispatch', () => {
  function runCursorHook(payload: unknown, cwd: string) {
    return spawnSync(
      process.execPath,
      [cliPath, 'hook', 'cursor', 'postToolUse'],
      {
        cwd,
        encoding: 'utf-8',
        input: JSON.stringify(payload),
      },
    );
  }

  // @lat: [[comment-reminder#Cursor postToolUse dispatch#Accepts postToolUse as a known cursor event]]
  it('accepts postToolUse as a known cursor event', () => {
    const res = runCursorHook({ tool_name: 'Read' }, process.cwd());
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('Unknown hook event');
  });

  // @lat: [[comment-reminder#Cursor postToolUse dispatch#Never fails the edit on a malformed payload]]
  it('never fails the edit on a malformed payload', () => {
    const res = spawnSync(
      process.execPath,
      [cliPath, 'hook', 'cursor', 'postToolUse'],
      { cwd: process.cwd(), encoding: 'utf-8', input: 'not json' },
    );
    expect(res.status).toBe(0);
  });
});

describe('resolveProjectRoot timeout', () => {
  // @lat: [[comment-reminder#git timeout]]
  it('returns quickly instead of hanging when git hangs', () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'lat-fake-git-'));
    const workDir = mkdtempSync(join(tmpdir(), 'lat-work-'));
    const fakeGitPath = join(fakeBinDir, 'git');
    writeFileSync(
      fakeGitPath,
      '#!/bin/sh\nsleep 5\necho /tmp\n',
      { mode: 0o755 },
    );
    chmodSync(fakeGitPath, 0o755);

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${fakeBinDir}:${originalPath}`;

      const filePath = join(workDir, 'foo.ts');
      const start = Date.now();
      const result = computeCommentReminder({
        session_id: randomUUID(),
        tool_input: {
          file_path: filePath,
          content:
            '// first line of prose explaining why\n// second line continuing the rationale\nconst x = 1;',
        },
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(3000);
      expect(result).toBeNull();
    } finally {
      process.env.PATH = originalPath;
      rmDirBestEffort(fakeBinDir);
      rmDirBestEffort(workDir);
    }
  });
});
