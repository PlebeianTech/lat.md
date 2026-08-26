import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCommentBlock,
  type PreToolUseInput,
} from '../src/cli/comment-guard.js';

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
  it('honours an explicit lat:ignore opt-out', () => {
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
});
