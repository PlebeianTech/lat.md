import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  plainStyler,
  type CmdContext,
} from '@plebeiantech/lat.md-core/context';
import {
  loadImpactIndex,
  reportSpecCoverage,
  type ImpactIndex,
} from '../src/cli/impact.js';

const projectRoot = join(import.meta.dirname, '..');
const contextFor = (root: string): CmdContext => ({
  latDir: join(root, 'lat.md'),
  projectRoot: root,
  styler: plainStyler,
  mode: 'cli',
});
const LAT_SECTION_COST = 4119;
const DEFAULT_DEPTH = 2;
const FIXTURE = 'src/cli/comment-reminder.ts#judgeWrittenComments';

let index: ImpactIndex;

beforeAll(async () => {
  index = await loadImpactIndex(contextFor(projectRoot));
}, 60_000);

describe('lat impact --specs', () => {
  // @lat: [[impact#Impact#Lists the specs that cover a symbol]]
  it('lists the specs from both documents that reference the symbol', async () => {
    const { output, isError } = await reportSpecCoverage(
      index,
      projectRoot,
      FIXTURE,
      { depth: DEFAULT_DEPTH },
    );
    expect(isError).toBeFalsy();
    expect(output).toMatch(/knowledge\/tests\/comment-guard\.md:\d+/);
    expect(output).toMatch(/knowledge\/tests\/comment-reminder\.md:\d+/);
    const results = output.split('\n').filter((l) => /\.md:\d+$/.test(l));
    for (const line of results) {
      expect(line).toMatch(/tests\//);
    }
    expect(output).not.toContain('code:');
  });

  // @lat: [[impact#Impact#Prints a clear empty result for an uncovered symbol]]
  it('prints a clear empty result for a symbol nothing references', async () => {
    const result = await reportSpecCoverage(
      index,
      projectRoot,
      'src/cli/impact.ts#formatTail',
      { depth: DEFAULT_DEPTH },
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      'No test spec covers src/cli/impact.ts#formatTail.',
    );
  });

  // @lat: [[impact#Impact#Prints a clear empty result for an uncovered symbol]]
  it('errors on a symbol that does not exist', async () => {
    const result = await reportSpecCoverage(
      index,
      projectRoot,
      'src/cli/impact.ts#noSuchSymbol',
      { depth: DEFAULT_DEPTH },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('src/cli/impact.ts#noSuchSymbol');
  });

  // @lat: [[impact#Impact#Stays under the cost of lat section for every symbol]]
  it('keeps the default output of every referenced symbol under the cost of lat section', async () => {
    const targets = [
      ...new Set(
        index.edges
          .map((e) => e.to)
          .filter((id) => id.startsWith('code:') && id.includes('#')),
      ),
    ].map((id) => id.slice('code:'.length));
    expect(targets.length).toBeGreaterThan(0);
    const oversize: { target: string; bytes: number }[] = [];
    for (const target of targets) {
      const { output } = await reportSpecCoverage(index, projectRoot, target, {
        depth: DEFAULT_DEPTH,
      });
      const bytes = Buffer.byteLength(output);
      if (bytes >= LAT_SECTION_COST) oversize.push({ target, bytes });
    }
    expect(oversize).toEqual([]);
  }, 120_000);
});

describe('lat impact --specs in a temporary repository', () => {
  let root: string;
  let tmpIndex: ImpactIndex;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lat-impact-specs-'));
    await mkdir(join(root, 'lat.md/tests'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'lat.md/tests/cases.md'),
      '# Cases\n\n## Inside case\n\nCovers the first function.\n\n## Above case\n\nCovers the first function from above.\n\n## Separated case\n\nCovers nothing in the first function.\n',
    );
    await writeFile(
      join(root, 'src/a.ts'),
      [
        '// @lat: [[tests/cases#Cases#Above case]]',
        'export function first(): number {',
        '  // @lat: [[tests/cases#Cases#Inside case]]',
        '  return 1;',
        '}',
        '',
        '// @lat: [[tests/cases#Cases#Separated case]]',
        '',
        'export function second(): number {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
    );
    tmpIndex = await loadImpactIndex(contextFor(root));
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // @lat: [[impact#Impact#Counts an @lat comment in or directly above the symbol]]
  it('lists the specs an @lat comment inside or directly above the symbol points at', async () => {
    const { output } = await reportSpecCoverage(
      tmpIndex,
      root,
      'src/a.ts#first',
      {
        depth: DEFAULT_DEPTH,
      },
    );
    expect(output).toContain('Inside case');
    expect(output).toContain('Above case');
    expect(output).not.toContain('Separated case');
  });

  // @lat: [[impact#Impact#Counts an @lat comment in or directly above the symbol]]
  it('ignores a comment separated from the declaration by a blank line', async () => {
    const { output } = await reportSpecCoverage(
      tmpIndex,
      root,
      'src/a.ts#second',
      {
        depth: DEFAULT_DEPTH,
      },
    );
    expect(output).toBe('No test spec covers src/a.ts#second.');
  });
});
