import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  plainStyler,
  type CmdContext,
} from '@plebeiantech/lat.md-core/context';
import { impactCommand } from '../src/cli/impact.js';

const contextFor = (root: string): CmdContext => ({
  latDir: join(root, 'lat.md'),
  projectRoot: root,
  styler: plainStyler,
  mode: 'cli',
});
const LAT_SECTION_COST = 4119;
const repositoryRoot = join(import.meta.dirname, '..');

let fixtureRoot: string;
let fixtureOutput: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'lat-impact-unreferenced-'));
  await mkdir(join(fixtureRoot, 'lat.md'));
  await writeFile(
    join(fixtureRoot, 'lat.md', 'index.md'),
    '# Index\n\nRoot document.\n',
  );
  await writeFile(
    join(fixtureRoot, 'lat.md', 'notes.md'),
    '# Notes\n\n## Orphan\n\nNothing links here.\n\n## Linked\n\nLinked from the Source section.\n\n## Source\n\nSee [[notes#Notes#Linked]].\n',
  );
  const result = await impactCommand(contextFor(fixtureRoot), undefined, {
    unreferenced: true,
  });
  fixtureOutput = result.output;
}, 60_000);

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('lat impact --unreferenced', () => {
  // @lat: [[impact#Impact#Lists a section nothing refers to]]
  it('lists a section with no inbound reference with its file and line', () => {
    expect(fixtureOutput).toMatch(/notes#Notes#Orphan {2}.*notes\.md:3/);
  });

  // @lat: [[impact#Impact#Omits a section that has a referrer]]
  it('omits a section with an inbound wikilink', () => {
    expect(fixtureOutput).not.toContain('notes#Notes#Linked');
  });

  // @lat: [[impact#Impact#Lists a root index document like any other]]
  it('lists a root index document', () => {
    expect(fixtureOutput).toMatch(/index#Index {2}.*index\.md:1/);
  });

  // @lat: [[impact#Impact#Bounds the unreferenced list and prints all on request]]
  it('stays under the cost of lat section and summarises the rest', async () => {
    const bounded = await impactCommand(contextFor(repositoryRoot), undefined, {
      unreferenced: true,
    });
    expect(Buffer.byteLength(bounded.output)).toBeLessThan(LAT_SECTION_COST);
    expect(bounded.output).toMatch(
      /\n\d+ more unreferenced \(--all lists them\)$/,
    );

    const all = await impactCommand(contextFor(repositoryRoot), undefined, {
      unreferenced: true,
      all: true,
    });
    expect(all.output).not.toContain('more unreferenced');
    expect(all.output.split('\n').length).toBeGreaterThan(
      bounded.output.split('\n').length,
    );
  }, 60_000);
});
