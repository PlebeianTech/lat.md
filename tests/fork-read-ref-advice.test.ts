import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirBestEffort } from './util.js';
import { buildReadRefAdvice } from '../src/fork/read-ref-advice.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmDirBestEffort(dir);
});

function makeProject(files: Record<string, string>): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'lat-read-ref-advice-'));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'lat.md'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(projectRoot, path, '..'), { recursive: true });
    writeFileSync(join(projectRoot, path), content);
  }
  return projectRoot;
}

describe('buildReadRefAdvice', () => {
  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#References in the range are advised]]
  it('advises both references in the range without section text', () => {
    const projectRoot = makeProject({
      'src/app.ts': [
        '// @lat: [[auth#OAuth Flow]]',
        'const a = 1;',
        '# @lat: [[cli#hook]]',
      ].join('\n'),
      'lat.md/auth.md': '# Auth\n\n## OAuth Flow\n\nSECRET SECTION TEXT\n',
    });

    const advice = buildReadRefAdvice({
      projectRoot,
      filePath: 'src/app.ts',
      firstLine: 1,
    });

    expect(advice).toContain('lat section "auth#OAuth Flow"');
    expect(advice).toContain('lat refs "auth#OAuth Flow"');
    expect(advice).toContain('lat section "cli#hook"');
    expect(advice).toContain('lat refs "cli#hook"');
    expect(advice).toContain('lat_section');
    expect(advice).not.toContain('SECRET SECTION TEXT');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#References outside the range are ignored]]
  it('ignores references outside the line range', () => {
    const projectRoot = makeProject({
      'src/app.ts': [
        '// @lat: [[before#Range]]',
        '// @lat: [[inside#Range]]',
        '// @lat: [[after#Range]]',
      ].join('\n'),
    });

    const advice = buildReadRefAdvice({
      projectRoot,
      filePath: join(projectRoot, 'src/app.ts'),
      firstLine: 2,
      lineCount: 1,
    });

    expect(advice).toContain('inside#Range');
    expect(advice).not.toContain('before#Range');
    expect(advice).not.toContain('after#Range');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#An alias is cut from the target]]
  it('advises an aliased reference by its target only', () => {
    const projectRoot = makeProject({
      'src/app.ts': '// @lat: [[cli#hook|the hook]]\n',
    });

    const advice = buildReadRefAdvice({
      projectRoot,
      filePath: 'src/app.ts',
      firstLine: 1,
    });

    expect(advice).toContain('lat section "cli#hook"');
    expect(advice).not.toContain('the hook');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#A Markdown file returns null]]
  it('returns null for a Markdown file', () => {
    const projectRoot = makeProject({ 'docs/notes.md': '// @lat: [[a#b]]\n' });

    expect(
      buildReadRefAdvice({
        projectRoot,
        filePath: 'docs/notes.md',
        firstLine: 1,
      }),
    ).toBeNull();
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#Targets unsafe in a shell command are left out]]
  it('leaves out targets that are unsafe in a shell command', () => {
    const projectRoot = makeProject({
      'src/app.ts': [
        '// @lat: [[a$(touch pwned)b]]',
        '# @lat: [[x" && touch pwned && echo "y]]',
        '// @lat: [[safe#Target]]',
      ].join('\n'),
    });

    const advice = buildReadRefAdvice({
      projectRoot,
      filePath: 'src/app.ts',
      firstLine: 1,
    });

    expect(advice).toContain('safe#Target');
    expect(advice).not.toContain('pwned');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#Each target is advised once per session]]
  it('advises each target once per session', () => {
    const projectRoot = makeProject({
      'src/app.ts': '// @lat: [[cli#hook]]\n',
    });
    const read = (sessionId?: string) =>
      buildReadRefAdvice({
        projectRoot,
        filePath: 'src/app.ts',
        firstLine: 1,
        sessionId,
      });
    const sessionId = randomUUID();

    expect(read(sessionId)).toContain('cli#hook');
    expect(read(sessionId)).toBeNull();
    expect(read(randomUUID())).toContain('cli#hook');
    expect(read()).toContain('cli#hook');
    expect(read()).toContain('cli#hook');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#Advice names at most five targets]]
  it('names five targets, counts the rest, and advises the rest later', () => {
    const targets = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const projectRoot = makeProject({
      'src/app.ts': targets.map((t) => `// @lat: [[${t}#S]]`).join('\n'),
    });
    const sessionId = randomUUID();
    const read = () =>
      buildReadRefAdvice({
        projectRoot,
        filePath: 'src/app.ts',
        firstLine: 1,
        sessionId,
      });

    const first = read();
    for (const t of targets.slice(0, 5)) expect(first).toContain(`"${t}#S"`);
    expect(first).not.toContain('t6#S');
    expect(first).not.toContain('t7#S');
    expect(first).toContain('2 more');

    const second = read();
    expect(second).toContain('"t6#S"');
    expect(second).toContain('"t7#S"');
    expect(second).not.toContain('t1#S');
    expect(second).not.toContain('more');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#Control characters are cleaned from a target]]
  it('cleans a control character from a target', () => {
    const projectRoot = makeProject({
      'src/app.ts': '// @lat: [[bell\u0007ring#S]]\n',
    });

    const advice = buildReadRefAdvice({
      projectRoot,
      filePath: 'src/app.ts',
      firstLine: 1,
    });

    expect(advice).toContain('lat section "bell ring#S"');
    expect(advice).not.toContain('\u0007');
  });

  // @lat: [[fork-read-ref-advice#Fork Read Ref Advice#Unusable files return null]]
  it('returns null for a missing file, an outside file and a lat.md file', () => {
    const projectRoot = makeProject({
      'lat.md/code.ts': '// @lat: [[a#b]]\n',
    });
    const outsideRoot = makeProject({ 'src/app.ts': '// @lat: [[a#b]]\n' });
    const read = (filePath: string) =>
      buildReadRefAdvice({ projectRoot, filePath, firstLine: 1 });

    expect(read('src/missing.ts')).toBeNull();
    expect(read(join(outsideRoot, 'src/app.ts'))).toBeNull();
    expect(read('lat.md/code.ts')).toBeNull();
  });
});
