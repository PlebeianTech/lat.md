import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CmdContext } from '@plebeiantech/lat.md-core/context';
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { rmDirBestEffort } from './util.js';
import { resolveLinkTarget } from '../src/cli/fork-resolve.js';

let projectRoot: string;

function writeProjectFile(path: string, content: string): void {
  const absolutePath = join(projectRoot, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content);
}

function makeContext(): CmdContext {
  return {
    latDir: join(projectRoot, 'lat.md'),
    projectRoot,
    styler: plainStyler,
    mode: 'cli',
  };
}

function resolveRef(ref: string) {
  return resolveLinkTarget(makeContext(), ref);
}

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'lat-fork-resolve-'));
  writeProjectFile(
    'lat.md/lat.md',
    [
      '---',
      'lat:',
      '  external-sources:',
      '    docs:',
      '      repo: https://github.com/example/docs.git',
      '      commit: 0123456789abcdef0123456789abcdef01234567',
      '      strategy: fetch',
      '---',
      '',
      '# Project',
      '',
      'The project overview.',
      '',
    ].join('\n'),
  );
  writeProjectFile(
    'lat.md/guide.md',
    '# Guide\n\nThe guide overview.\n\n## Setup\n\nHow to set it up.\n',
  );
  writeProjectFile('lat.md/one/usage.md', '# Usage\n\nFirst usage.\n');
  writeProjectFile('lat.md/two/usage.md', '# Usage\n\nSecond usage.\n');
  writeProjectFile(
    'src/app.ts',
    [
      'export const VERSION = 1;',
      '',
      'export function greet(name: string): string {',
      '  return `hi ${name}`;',
      '}',
      '',
      'export class Greeter {',
      '  hello(): string {',
      "    return 'hello';",
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeProjectFile('notes.txt', 'Plain notes.\n');
});

afterAll(() => rmDirBestEffort(projectRoot));

describe('resolveLinkTarget', () => {
  // @lat: [[tests/fork-resolve#Full section id resolves to its heading line]]
  it('resolves a full section id to its file and heading line', async () => {
    expect(await resolveRef('lat.md/guide#Guide#Setup')).toEqual({
      file: join(projectRoot, 'lat.md/guide.md'),
      line: 5,
    });
  });

  // @lat: [[tests/fork-resolve#Short section ref resolves like lat check]]
  it('resolves a short section ref the way lat check does', async () => {
    expect(await resolveRef('guide#Setup')).toEqual({
      file: join(projectRoot, 'lat.md/guide.md'),
      line: 5,
    });
  });

  // @lat: [[tests/fork-resolve#Ambiguous short ref lists candidates]]
  it('returns an error listing every candidate for an ambiguous short ref', async () => {
    const result = await resolveRef('usage');
    expect(result).toHaveProperty('error');
    const { error } = result as { error: string };
    expect(error).toContain('lat.md/one/usage');
    expect(error).toContain('lat.md/two/usage');
  });

  // @lat: [[tests/fork-resolve#Bracketed ref with alias resolves]]
  it('drops surrounding brackets and an alias before resolving', async () => {
    expect(await resolveRef('[[guide#Setup|the setup steps]]')).toEqual({
      file: join(projectRoot, 'lat.md/guide.md'),
      line: 5,
    });
  });

  // @lat: [[tests/fork-resolve#Source symbol ref resolves to its declaration line]]
  it('resolves a source symbol ref to the line of its declaration', async () => {
    const file = join(projectRoot, 'src/app.ts');
    expect(await resolveRef('src/app.ts#greet')).toEqual({ file, line: 3 });
    expect(await resolveRef('src/app.ts#Greeter#hello')).toEqual({
      file,
      line: 8,
    });
  });

  // @lat: [[tests/fork-resolve#Missing source symbol is an error]]
  it('returns an error when the source symbol does not exist', async () => {
    expect(await resolveRef('src/app.ts#missing')).toEqual({
      error:
        'broken link [[src/app.ts#missing]] — symbol "missing" not found in "src/app.ts"',
    });
  });

  // @lat: [[tests/fork-resolve#Source file ref without symbol resolves to line one]]
  it('resolves a source file ref with no symbol to line 1', async () => {
    expect(await resolveRef('src/app.ts')).toEqual({
      file: join(projectRoot, 'src/app.ts'),
      line: 1,
    });
  });

  // @lat: [[tests/fork-resolve#Plain file ref resolves to line one]]
  it('resolves a plain non-source file to line 1', async () => {
    expect(await resolveRef('notes.txt')).toEqual({
      file: join(projectRoot, 'notes.txt'),
      line: 1,
    });
  });

  // @lat: [[tests/fork-resolve#Directory ref is an error]]
  it('returns an error for a directory ref', async () => {
    expect(await resolveRef('src')).toEqual({
      error: 'directory refs cannot be opened',
    });
  });

  // @lat: [[tests/fork-resolve#Unknown ref is an error]]
  it('returns an error naming an unknown ref', async () => {
    const result = await resolveRef('no-such#thing');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('no-such#thing');
  });

  // @lat: [[tests/fork-resolve#External source ref is an error]]
  it('returns an error for an external-source ref without fetching it', async () => {
    const result = await resolveRef('docs:intro.md#Start');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain(
      'external refs are not supported',
    );
  });
});

// @lat: [[tests/fork-resolve#CLI prints errors as JSON on stdout]]
it('prints an error as JSON on stdout and exits with code 1', () => {
  const cli = resolve('dist/src/cli/index.js');
  const result = spawnSync(
    process.execPath,
    [cli, '--dir', projectRoot, 'resolve', 'no-such#thing'],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toHaveProperty('error');
});
