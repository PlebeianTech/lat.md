import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCommentBlock,
  type PreToolUseInput,
} from '../src/cli/comment-guard.js';
import {
  computeCommentReminder,
  type PostToolUseInput,
} from '../src/cli/comment-reminder.js';

let projectDir: string;

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'lat-comment-guard-'));
  mkdirSync(join(projectDir, 'lat.md'), { recursive: true });
  writeFileSync(join(projectDir, 'lat.md', 'lat.md'), '# Root\n\nIndex.\n');
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function block(file: string, content: string): string | null {
  const input: PreToolUseInput = {
    hook_event_name: 'PreToolUse',
    cwd: projectDir,
    tool_name: 'Write',
    tool_input: { file_path: join(projectDir, file), content },
  };
  return computeCommentBlock(input);
}

function remind(file: string, content: string): string | null {
  const input: PostToolUseInput = {
    hook_event_name: 'PostToolUse',
    cwd: projectDir,
    tool_name: 'Write',
    tool_input: { file_path: join(projectDir, file), content },
  };
  return computeCommentReminder(input);
}

function seed(file: string, content: string): string {
  writeFileSync(join(projectDir, file), content);
  return content;
}

function blockEdit(file: string, newString: string): string | null {
  const input: PreToolUseInput = {
    hook_event_name: 'PreToolUse',
    cwd: projectDir,
    tool_name: 'Edit',
    tool_input: { file_path: join(projectDir, file), new_string: newString },
  };
  return computeCommentBlock(input);
}

function remindEdit(file: string, newString: string): string | null {
  const input: PostToolUseInput = {
    hook_event_name: 'PostToolUse',
    cwd: projectDir,
    tool_name: 'Edit',
    tool_input: { file_path: join(projectDir, file), new_string: newString },
  };
  return computeCommentReminder(input);
}

const RATIONALE = [
  '// We retry three times because the upstream API rate-limits bursts',
  '// and a single failure is almost always transient.',
  'export const RETRIES = 3;',
  '',
].join('\n');

const JSDOC = [
  '/**',
  ' * Strips control characters before the text reaches a terminal, because a',
  ' * pasted escape sequence would otherwise redraw the screen.',
  ' */',
  'export function cleanUntrusted(text: string): string {',
  '  return text;',
  '}',
  '',
].join('\n');

describe('comment guard', () => {
  // @lat: [[comment-guard#Blocks a multi-line rationale comment]]
  it('blocks a multi-line rationale comment', () => {
    const reason = block(
      'widget.ts',
      [
        '// We retry three times because the upstream API rate-limits bursts',
        '// and a single failure is almost always transient.',
        'export const RETRIES = 3;',
      ].join('\n'),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('widget.ts');
    expect(reason).toContain('@lat:');
  });

  // @lat: [[comment-guard#Allows a single bare-fact comment]]
  it('allows a single bare-fact comment', () => {
    const reason = block(
      'widget.ts',
      ['// milliseconds', 'export const TIMEOUT = 2000;'].join('\n'),
    );
    expect(reason).toBeNull();
  });

  // @lat: [[comment-guard#Allows a comment that is already a pointer]]
  it('allows comment lines that are already @lat: pointers', () => {
    const reason = block(
      'widget.ts',
      [
        '// @lat: [[some#Section]]',
        '// @lat: [[other#Section]]',
        'export const X = 1;',
      ].join('\n'),
    );
    expect(reason).toBeNull();
  });

  // @lat: [[comment-guard#Honours an explicit ignore token]]
  it('honours an explicit per-line opt-out token', () => {
    const reason = block(
      'widget.ts',
      [
        '// lat:ignore this line documents the wire format verbatim',
        '// lat:ignore and this one continues it',
        'export const WIRE = 1;',
      ].join('\n'),
    );
    expect(reason).toBeNull();
  });

  // @lat: [[comment-reminder#Honours the same opt-out token as the guard]]
  it('neither denies nor reminds when every line carries the opt-out token', () => {
    const content = [
      '// lat:ignore keep this wire-format note verbatim',
      '// lat:ignore and this second line continues it',
      'export const WIRE = 1;',
    ].join('\n');
    expect(block('exempt.ts', content)).toBeNull();
    expect(remind('exempt.ts', content)).toBeNull();
  });

  // @lat: [[comment-guard#Never gates markdown]]
  it('never gates markdown', () => {
    const reason = block(
      'notes.md',
      ['# Heading', '', 'Prose belongs here.'].join('\n'),
    );
    expect(reason).toBeNull();
  });

  // @lat: [[comment-guard#Fires every time, with no per-session dedup]]
  it('fires every time for the same file', () => {
    const content = [
      '// The cache is keyed by locale because two jurisdictions can hold',
      '// bills with identical external ids.',
      'const CACHE = new Map();',
    ].join('\n');
    const first = block('repeat.ts', content);
    const second = block('repeat.ts', content);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).toEqual(first);
  });

  // @lat: [[comment-guard#Fails open on an unusable payload]]
  it('fails open when the payload names no file', () => {
    expect(
      computeCommentBlock({ tool_name: 'Write', tool_input: {} }),
    ).toBeNull();
  });

  // @lat: [[comment-guard#Allows a whole-file rewrite that changes nothing]]
  it('allows a whole-file write that re-emits the file verbatim', () => {
    const content = seed('verbatim.ts', RATIONALE);
    expect(block('verbatim.ts', content)).toBeNull();
    expect(remind('verbatim.ts', content)).toBeNull();
  });

  // @lat: [[comment-guard#Still blocks new prose in a whole-file rewrite]]
  it('still blocks a whole-file write that adds a new rationale block', () => {
    seed('grown.ts', RATIONALE);
    const reason = block(
      'grown.ts',
      RATIONALE +
        [
          '',
          '// The cache is keyed by locale because two jurisdictions can hold',
          '// bills with identical external ids.',
          'const CACHE = new Map();',
          '',
        ].join('\n'),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('2 comment lines');
  });

  // @lat: [[comment-guard#Names both exits in the denial]]
  it('names both exits in the denial text', () => {
    const reason = block(
      'exits.ts',
      [
        '// We debounce at 300ms because anything shorter re-renders the whole',
        '// tree on every keystroke and drops frames on low-end phones.',
        'const DEBOUNCE = 300;',
      ].join('\n'),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('lat:ignore');
    expect(reason).toContain('whole-file `Write`');
  });

  // @lat: [[comment-guard#Allows an edit that re-emits an existing comment block]]
  it('allows an edit that re-emits an existing comment block verbatim', () => {
    seed('untrusted.ts', JSDOC);
    const newString = JSDOC.replace('return text;', 'return text.trim();');
    expect(blockEdit('untrusted.ts', newString)).toBeNull();
    expect(remindEdit('untrusted.ts', newString)).toBeNull();
  });

  // @lat: [[comment-guard#Still blocks new prose beside a re-emitted block]]
  it('still blocks an edit that adds new prose beside a re-emitted block', () => {
    seed('untrusted-grown.ts', JSDOC);
    const newString =
      [
        '// We trim first because the caller hands us raw terminal input and a',
        '// trailing newline would survive the control-character strip.',
        '',
      ].join('\n') + JSDOC.replace('return text;', 'return text.trim();');
    const reason = blockEdit('untrusted-grown.ts', newString);
    expect(reason).not.toBeNull();
    expect(reason).toContain('2 comment lines');
  });

  // @lat: [[comment-reminder#Counts only what a whole-file rewrite adds]]
  it('reminds about the added lines only, not the whole file', () => {
    seed('counted.ts', RATIONALE);
    const message = remind(
      'counted.ts',
      RATIONALE +
        [
          '',
          '// Locale is part of the key because two jurisdictions can hold',
          '// bills with identical external ids.',
          'const CACHE = new Map();',
          '',
        ].join('\n'),
    );
    expect(message).not.toBeNull();
    expect(message).toContain('2 comment line(s)');
  });
});
