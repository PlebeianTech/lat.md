import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rmDirBestEffort } from '../util.js';
import { findSectionsLinkedToSymbols } from '../../src/knowledge/caller-sections.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-caller-sections-'));
  dirsToClean.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SPEC = `# Spec

## Alpha

Alpha section.

## Beta

Beta section.
`;

describe('findSectionsLinkedToSymbols', () => {
  // @lat: [[tests/fork-caller-sections#Comment above the symbol links its section]]
  it('returns a section referenced on the line above the symbol', async () => {
    const root = makeProject({
      'lat.md/spec.md': SPEC,
      'src/a.ts': '// @lat: [[spec#Alpha]]\nexport function foo() {}\n',
    });
    expect(
      await findSectionsLinkedToSymbols(root, [
        { file: 'src/a.ts', name: 'foo' },
      ]),
    ).toEqual(['lat.md/spec#Spec#Alpha']);
  });

  // @lat: [[tests/fork-caller-sections#Comment inside the symbol links its section]]
  it('returns a section referenced inside the symbol body', async () => {
    const root = makeProject({
      'lat.md/spec.md': SPEC,
      'src/a.ts':
        'export function foo() {\n  // @lat: [[spec#Alpha]]\n  return 1;\n}\n',
    });
    expect(
      await findSectionsLinkedToSymbols(root, [
        { file: 'src/a.ts', name: 'foo' },
      ]),
    ).toEqual(['lat.md/spec#Spec#Alpha']);
  });

  // @lat: [[tests/fork-caller-sections#Wiki link to the symbol links its section]]
  it('returns a section whose text links the symbol', async () => {
    const root = makeProject({
      'lat.md/spec.md': `${SPEC}\n## Gamma\n\nSee [[src/a.ts#foo]].\n`,
      'src/a.ts': 'export function foo() {}\n',
    });
    expect(
      await findSectionsLinkedToSymbols(root, [
        { file: 'src/a.ts', name: 'foo' },
      ]),
    ).toEqual(['lat.md/spec#Spec#Gamma']);
  });

  // @lat: [[tests/fork-caller-sections#Other symbols in the same file are not linked]]
  it('leaves out sections linked only to another symbol', async () => {
    const root = makeProject({
      'lat.md/spec.md': `${SPEC}\n## Gamma\n\nSee [[src/a.ts#bar]].\n`,
      'src/a.ts':
        '// @lat: [[spec#Beta]]\nexport function bar() {}\n\nexport function foo() {}\n',
    });
    expect(
      await findSectionsLinkedToSymbols(root, [
        { file: 'src/a.ts', name: 'foo' },
      ]),
    ).toEqual([]);
  });

  // @lat: [[tests/fork-caller-sections#Unknown files and symbols give nothing]]
  it('returns an empty list for unknown files and symbols', async () => {
    const root = makeProject({
      'lat.md/spec.md': SPEC,
      'src/a.ts': 'export function foo() {}\n',
    });
    expect(
      await findSectionsLinkedToSymbols(root, [
        { file: 'src/missing.ts', name: 'foo' },
        { file: 'src/a.ts', name: 'missing' },
      ]),
    ).toEqual([]);
    expect(
      await findSectionsLinkedToSymbols(join(root, 'nope'), [
        { file: 'src/a.ts', name: 'foo' },
      ]),
    ).toEqual([]);
  });

  // @lat: [[tests/fork-caller-sections#Sections of several symbols are deduplicated]]
  it('deduplicates sections across symbols', async () => {
    const root = makeProject({
      'lat.md/spec.md': SPEC,
      'src/a.ts':
        '// @lat: [[spec#Alpha]]\nexport function foo() {}\n\n// @lat: [[spec#Alpha]]\nexport function bar() {}\n',
    });
    expect(
      await findSectionsLinkedToSymbols(root, [
        { file: 'src/a.ts', name: 'foo' },
        { file: 'src/a.ts', name: 'bar' },
      ]),
    ).toEqual(['lat.md/spec#Spec#Alpha']);
  });
});
