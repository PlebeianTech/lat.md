import { beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  plainStyler,
  type CmdContext,
} from '@plebeiantech/lat.md-core/context';
import { commandProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import { flattenSections } from '@plebeiantech/lat.md-core/lattice-model';
import {
  impactCommand,
  loadImpactIndex,
  reportImpact,
  type ImpactIndex,
} from '../src/cli/impact.js';

const projectRoot = join(import.meta.dirname, '..');
const ctx: CmdContext = {
  latDir: join(projectRoot, 'lat.md'),
  projectRoot,
  styler: plainStyler,
  mode: 'cli',
};
const LAT_SECTION_COST = 4119;
const DEFAULT_DEPTH = 2;

let index: ImpactIndex;

beforeAll(async () => {
  index = await loadImpactIndex(ctx);
}, 60_000);

describe('lat impact', () => {
  // @lat: [[impact#Impact#Lists depth 1 and depth 2 with a tail summary]]
  it('lists depth 1 and 2 with file:line and a one-line tail summary', () => {
    const { output, isError } = reportImpact(index, 'cli#CLI#gen', {
      depth: DEFAULT_DEPTH,
    });
    expect(isError).toBeFalsy();
    const lines = output.split('\n');
    expect(lines[0]).toMatch(/^\d+ sections? affected by /);
    expect(output).toContain('depth 1');
    expect(output).toContain('depth 2');
    expect(output).not.toContain('depth 3:');
    const results = lines.filter((l) => /\.md:\d+$/.test(l));
    expect(results.length).toBeGreaterThan(0);
    expect(output).toMatch(/\n\d+ more at depth 3(-\d+)?\b/);
  });

  // @lat: [[impact#Impact#Lists the tail on request]]
  it('--depth lists the tail the default hid', () => {
    const shallow = reportImpact(index, 'cli#CLI#gen', { depth: 2 }).output;
    const deep = reportImpact(index, 'cli#CLI#gen', { depth: 5 }).output;
    expect(deep).toContain('depth 3');
    expect(
      deep.split('\n').filter((l) => /\.md:\d+$/.test(l)).length,
    ).toBeGreaterThan(
      shallow.split('\n').filter((l) => /\.md:\d+$/.test(l)).length,
    );
    expect(deep).toMatch(/\n\d+ more at depth 6/);
    const everything = reportImpact(index, 'cli#CLI#gen', { depth: 99 }).output;
    expect(everything).not.toMatch(/more at depth/);
  });

  // @lat: [[impact#Impact#Prints a clear empty result]]
  it('prints a clear empty result for a section nothing refers to', () => {
    const sections = flattenSections(index.sections);
    const isolated = sections.find((s) =>
      reportImpact(index, s.id, { depth: 5 }).output.startsWith('No section'),
    );
    expect(isolated).toBeDefined();
    const result = reportImpact(index, isolated!.id, { depth: 2 });
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(`No section depends on ${isolated!.id}.`);
  });

  // @lat: [[impact#Impact#Resolves short and canonical ids alike]]
  it('gives identical output for short, medium and canonical ids', () => {
    const short = reportImpact(index, 'cli#gen', { depth: 2 }).output;
    const medium = reportImpact(index, 'cli#CLI#gen', { depth: 2 }).output;
    const canonical = reportImpact(index, 'lat.md/knowledge/cli#CLI#gen', {
      depth: 2,
    }).output;
    expect(short).toBe(medium);
    expect(canonical).toBe(medium);
    const firstResult = medium.split('\n').find((l) => /\.md:\d+$/.test(l))!;
    const [, location] = /\s(\S+\.md:\d+)$/.exec(firstResult)!;
    const [file, line] = location.split(':');
    const section = flattenSections(index.sections).find(
      (s) => s.filePath === file && s.startLine === Number(line),
    );
    expect(section).toBeDefined();
  });

  // @lat: [[impact#Impact#Stays under the cost of lat section]]
  it('keeps the default output of the worst case under the cost of lat section', () => {
    const { output } = reportImpact(index, 'cli#CLI#gen', {
      depth: DEFAULT_DEPTH,
    });
    expect(Buffer.byteLength(output)).toBeLessThan(LAT_SECTION_COST);
  });

  // @lat: [[impact#Impact#Stays under the cost of lat section]]
  it('keeps the default output of every section under the cost of lat section', async () => {
    const { allSections } = await commandProjectAnalysis(ctx);
    const oversize = flattenSections(allSections)
      .map((s) => ({
        id: s.id,
        bytes: Buffer.byteLength(
          reportImpact(index, s.id, { depth: DEFAULT_DEPTH }).output,
        ),
      }))
      .filter((r) => r.bytes >= LAT_SECTION_COST);
    expect(oversize).toEqual([]);
  }, 120_000);

  // @lat: [[impact#Impact#Rejects an unknown section]]
  it('errors on a query that matches no section', async () => {
    const result = await impactCommand(ctx, 'no-such-doc#No such heading', {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('no-such-doc#No such heading');
  });

  // @lat: [[impact#Impact#Rejects an unknown section]]
  it('errors on a depth that is not a positive integer', async () => {
    const result = await impactCommand(ctx, 'cli#gen', { depth: '0' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('--depth');
  });

  // @lat: [[impact#Impact#Lists the tail on request]]
  it('finishes for an enormous depth and prints what a sufficient depth prints', () => {
    const huge = reportImpact(index, 'cli#CLI#gen', { depth: 99_999_999_999 });
    const enough = reportImpact(index, 'cli#CLI#gen', { depth: 99 });
    expect(huge.output).toBe(enough.output);
  });

  // @lat: [[impact#Impact#Stays under the cost of lat section]]
  it('caps a long listing under the cost of lat section and counts the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lat-impact-cap-'));
    try {
      await mkdir(join(root, 'lat.md'), { recursive: true });
      const dependents = Array.from(
        { length: 120 },
        (_, i) =>
          `## Dependent section number ${i} with a long heading\n\nUses [[many#Many#Target]].\n`,
      );
      await writeFile(join(root, 'lat.md/lat.md'), '# Lat\n\n- [[many]]\n');
      await writeFile(
        join(root, 'lat.md/many.md'),
        `# Many\n\nIntro.\n\n## Target\n\nTarget body.\n\n${dependents.join('\n')}`,
      );
      const tmpIndex = await loadImpactIndex({
        latDir: join(root, 'lat.md'),
        projectRoot: root,
        styler: plainStyler,
        mode: 'cli',
      });
      const capped = reportImpact(tmpIndex, 'many#Many#Target', {
        depth: DEFAULT_DEPTH,
      }).output;
      expect(Buffer.byteLength(capped)).toBeLessThan(LAT_SECTION_COST);
      const shown = capped.split('\n').filter((l) => /\.md:\d+$/.test(l));
      const more = /\n\n(\d+) more not shown \(--all lists them\)$/.exec(
        capped,
      );
      expect(more).not.toBeNull();
      expect(shown.length + Number(more![1])).toBe(120);

      const all = reportImpact(tmpIndex, 'many#Many#Target', {
        depth: DEFAULT_DEPTH,
        all: true,
      }).output;
      expect(all).not.toContain('more not shown');
      expect(all.split('\n').filter((l) => /\.md:\d+$/.test(l))).toHaveLength(
        120,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // @lat: [[impact#Impact#Walks through code nodes]]
  it('reaches a section that links a symbol whose @lat comment points at the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lat-impact-walk-'));
    try {
      await mkdir(join(root, 'lat.md'), { recursive: true });
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'lat.md/lat.md'), '# Lat\n\n- [[alpha]]\n');
      await writeFile(
        join(root, 'lat.md/alpha.md'),
        '# Alpha\n\nAlpha intro.\n\n## Gamma\n\nGamma body.\n\n## Delta\n\nDelta documents [[src/x.ts#foo]].\n',
      );
      await writeFile(
        join(root, 'src/x.ts'),
        'export function foo(): number {\n  // @lat: [[alpha#Alpha#Gamma]]\n  return 1;\n}\n',
      );
      const tmpIndex = await loadImpactIndex({
        latDir: join(root, 'lat.md'),
        projectRoot: root,
        styler: plainStyler,
        mode: 'cli',
      });
      const { output } = reportImpact(tmpIndex, 'alpha#Alpha#Gamma', {
        depth: 5,
      });
      expect(output).toMatch(/alpha#Alpha#Delta {2}lat\.md\/alpha\.md:\d+/);
      expect(output).not.toContain('src/x.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
