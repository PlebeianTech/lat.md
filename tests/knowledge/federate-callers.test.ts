import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirBestEffort } from '../util.js';
import { federateTags } from '../../src/knowledge/index.js';
import type {
  KnowledgeHit,
  Store,
  TaggedDoc,
} from '../../src/knowledge/types.js';

const providerScript = join(__dirname, '../fixtures/callers-provider.cjs');
const dirsToClean: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-federate-callers-'));
  dirsToClean.push(dir);
  return dir;
}

/** A project whose document `lat.md/doc.md` has the given body. */
function projectWithDoc(body: string): { root: string; docs: TaggedDoc[] } {
  const root = tempDir();
  mkdirSync(join(root, 'lat.md'));
  writeFileSync(join(root, 'lat.md', 'doc.md'), `# Doc\n\n${body}\n`);
  return { root, docs: [{ id: 'lat.md/doc.md', tags: ['alpha'] }] };
}

function storeWithHits(count: number): Store {
  return {
    name: 'bd',
    async query(): Promise<KnowledgeHit[]> {
      return Array.from({ length: count }, (_, i) => ({
        store: 'bd',
        key: `bd-${i}`,
        title: `bd hit ${i}`,
        detail: '',
        score: 1,
      }));
    },
  };
}

function registerStores(entries: unknown): void {
  const configHome = tempDir();
  mkdirSync(join(configHome, 'lat'));
  writeFileSync(
    join(configHome, 'lat', 'config.json'),
    JSON.stringify({ knowledge_stores: entries }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
}

/** Registers the fixture provider; it prints `output` for any request. */
function registerProvider(
  output: unknown,
  label = 'Fixture',
): { stdinFile: string } {
  const stdinFile = join(tempDir(), 'stdin.json');
  registerStores([
    {
      name: 'fixture',
      label,
      command: [
        process.execPath,
        providerScript,
        stdinFile,
        JSON.stringify(output),
      ],
      operations: ['callers'],
    },
  ]);
  return { stdinFile };
}

const caller = (name: string, line: number) => ({
  file: 'src/app.ts',
  name,
  line,
});
const answer = (name: string, callers: unknown[]) => [
  { symbol: { file: 'src/a.ts', name }, callers },
];

function sentSymbols(stdinFile: string): { file: string; name: string }[] {
  return JSON.parse(readFileSync(stdinFile, 'utf-8')).symbols;
}

describe('federateTags callers group', () => {
  // @lat: [[fork-federate-callers#Callers of a linked symbol are listed after the store hits]]
  it('lists the callers of a linked symbol after the store hits', async () => {
    const { root, docs } = projectWithDoc('See [[src/a.ts#foo]].');
    registerProvider(answer('foo', [caller('run', 7)]), 'Code\nGraph');
    const output = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(1)],
    });
    expect(output!.split('\n').slice(3).join('\n')).toBe(
      [
        'lat.md/doc.md (alpha):',
        'bd memories:',
        '- "bd hit 0"',
        'Callers (Code Graph):',
        '- "run (src/app.ts:7)"',
      ].join('\n'),
    );
  });

  // @lat: [[fork-federate-callers#Only source symbol links are sent to the provider]]
  it('sends only source file links that name a symbol', async () => {
    const { root, docs } = projectWithDoc(
      [
        '[[src/a.ts#foo]] [[src/a.ts]] [[other#Some Section]]',
        '[[docs/readme.md#Intro]] [[src/b.ts#Klass#method]]',
      ].join('\n'),
    );
    const { stdinFile } = registerProvider([]);
    await federateTags(docs, { projectRoot: root, stores: [storeWithHits(1)] });
    expect(sentSymbols(stdinFile)).toEqual([
      { file: 'src/a.ts', name: 'foo' },
      { file: 'src/b.ts', name: 'Klass#method' },
    ]);
  });

  // @lat: [[fork-federate-callers#A document sends at most ten symbols]]
  it('sends the first ten of twelve linked symbols', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `fn${i}`);
    const { root, docs } = projectWithDoc(
      names.map((name) => `[[src/a.ts#${name}]]`).join(' '),
    );
    const { stdinFile } = registerProvider([]);
    await federateTags(docs, { projectRoot: root, stores: [storeWithHits(1)] });
    expect(sentSymbols(stdinFile).map((s) => s.name)).toEqual(
      names.slice(0, 10),
    );
  });

  // @lat: [[fork-federate-callers#A document shows at most three callers]]
  it('shows three callers when the provider returns five', async () => {
    const { root, docs } = projectWithDoc('[[src/a.ts#foo]]');
    registerProvider(
      answer(
        'foo',
        [1, 2, 3, 4, 5].map((n) => caller(`c${n}`, n)),
      ),
    );
    const output = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(1)],
    });
    expect(output).toContain('- "c3 (src/app.ts:3)"');
    expect(output).not.toContain('c4');
  });

  // @lat: [[fork-federate-callers#Caller lines count against the total hit cap]]
  it('cuts caller lines first when the total hit cap runs out', async () => {
    const { root, docs } = projectWithDoc('[[src/a.ts#foo]]');
    registerProvider(
      answer(
        'foo',
        [1, 2, 3].map((n) => caller(`c${n}`, n)),
      ),
    );
    const output = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(2)],
      maxTotalHits: 3,
    });
    const hitLines = output!.split('\n').filter((l) => l.startsWith('- '));
    expect(hitLines).toEqual([
      '- "bd hit 0"',
      '- "bd hit 1"',
      '- "c1 (src/app.ts:1)"',
    ]);
  });

  // @lat: [[fork-federate-callers#A full cap skips the provider]]
  it('does not run the provider when store hits fill the cap', async () => {
    const { root, docs } = projectWithDoc('[[src/a.ts#foo]]');
    const { stdinFile } = registerProvider(answer('foo', [caller('run', 7)]));
    const output = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(2)],
      maxTotalHits: 2,
    });
    expect(output).not.toContain('Callers');
    expect(existsSync(stdinFile)).toBe(false);
  });

  // @lat: [[fork-federate-callers#Without a provider the output is unchanged]]
  it('prints no callers group without a callers provider', async () => {
    const { root, docs } = projectWithDoc('[[src/a.ts#foo]]');
    const expected = [
      'lat.md/doc.md (alpha):',
      'bd memories:',
      '- "bd hit 0"',
    ].join('\n');
    const none = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(1)],
    });
    expect(none!.split('\n').slice(3).join('\n')).toBe(expected);
    registerStores([
      {
        name: 'fixture',
        label: 'Fixture',
        command: [process.execPath, '-e', ''],
      },
    ]);
    const queryOnly = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(1)],
    });
    expect(queryOnly).toBe(none);
  });

  // @lat: [[fork-federate-callers#A late provider leaves the other groups intact]]
  it('omits the callers group when the provider outlasts the deadline', async () => {
    const { root, docs } = projectWithDoc('[[src/a.ts#foo]]');
    registerStores([
      {
        name: 'fixture',
        label: 'Fixture',
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        operations: ['callers'],
        timeout_ms: 60000,
      },
    ]);
    const started = Date.now();
    const output = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(1)],
      deadlineMs: 400,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(output!.split('\n').slice(3).join('\n')).toBe(
      ['lat.md/doc.md (alpha):', 'bd memories:', '- "bd hit 0"'].join('\n'),
    );
  });

  // @lat: [[fork-federate-callers#A document without store hits is not shown for its callers]]
  it('does not show a document that has callers but no store hits', async () => {
    const { root, docs } = projectWithDoc('[[src/a.ts#foo]]');
    const { stdinFile } = registerProvider(answer('foo', [caller('run', 7)]));
    const output = await federateTags(docs, {
      projectRoot: root,
      stores: [storeWithHits(0)],
    });
    expect(output).toBeNull();
    expect(existsSync(stdinFile)).toBe(false);
  });
});
