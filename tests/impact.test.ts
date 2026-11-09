import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  plainStyler,
  type CmdContext,
} from '@plebeiantech/lat.md-core/context';
import { commandProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import {
  flattenSections,
  type Section,
} from '@plebeiantech/lat.md-core/lattice-model';
import {
  buildImpactIndex,
  impactCommand,
  loadImpactIndex,
  reportImpact,
  type ImpactIndex,
} from '../src/cli/impact.js';
import type { GraphEdge } from '../src/graph-export.js';

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

  // @lat: [[impact#Impact#Walks through code nodes]]
  it('finds a section whose only dependency path crosses a code-ref edge', () => {
    const section = (id: string, line: number): Section => ({
      id,
      heading: id,
      depth: 1,
      file: id,
      filePath: `${id}.md`,
      children: [],
      startLine: line,
      endLine: line,
      firstParagraph: '',
    });
    const a = section('a', 1);
    const b = section('b', 2);
    const edges: GraphEdge[] = [
      {
        from: 'code:src/x.ts:3',
        to: 'section:a',
        type: 'code-ref',
        role: 'implements',
      },
      {
        from: 'section:b',
        to: 'code:src/x.ts:3',
        type: 'wikilink',
        role: 'symbol-ref',
      },
    ];
    const result = reportImpact(
      buildImpactIndex([a, b], edges, new Set()),
      'a',
      {
        depth: 2,
      },
    );
    expect(result.output).toContain('b  b.md:2');
    expect(result.output).not.toContain('src/x.ts');
  });
});
