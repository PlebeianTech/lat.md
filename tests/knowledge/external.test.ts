import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfigPath } from '@plebeiantech/lat.md-core/config';
import { rmDirBestEffort } from '../util.js';
import { DEFAULT_STORES, federateTags } from '../../src/knowledge/index.js';
import { externalStores } from '../../src/knowledge/external.js';
import type {
  KnowledgeHit,
  Store,
  StoreName,
  TaggedDoc,
} from '../../src/knowledge/types.js';

const dirsToClean: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-external-store-'));
  dirsToClean.push(dir);
  return dir;
}

/** Writes a small Node script and returns the command that runs it. */
function fakeStoreCommand(script: string): string[] {
  const path = join(tempDir(), 'store.cjs');
  writeFileSync(path, script);
  return [process.execPath, path];
}

/** A fake store that saves its stdin, then prints `stdout` and exits. */
function answeringStore(
  stdout: string,
  options: { exitCode?: number; stdinFile?: string } = {},
): string[] {
  return fakeStoreCommand(`
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const stdinFile = ${JSON.stringify(options.stdinFile ?? null)};
  if (stdinFile) require('node:fs').writeFileSync(stdinFile, input);
  process.stdout.write(${JSON.stringify(stdout)});
  process.exitCode = ${options.exitCode ?? 0};
});
`);
}

/** A fake store that saves its pid and never answers. */
function silentStore(pidFile: string): string[] {
  return fakeStoreCommand(`
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
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

function fakeBuiltInStore(name: StoreName): Store {
  return {
    name,
    async query(): Promise<KnowledgeHit[]> {
      return [
        {
          store: name,
          key: `${name}-1`,
          title: `${name} hit`,
          detail: '',
          score: 1,
        },
      ];
    },
  };
}

const twoHits = JSON.stringify([
  { key: 'k1', title: 'first fixture hit', detail: 'one', score: 2 },
  { key: 'k2', title: 'second fixture hit', detail: 'two', score: 1 },
]);

const docs: TaggedDoc[] = [{ id: 'a.md', tags: ['alpha'] }];
const query = { terms: ['alpha'], projectRoot: '/tmp', limit: 3 };

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe('external knowledge stores', () => {
  // @lat: [[fork-external-stores#A registered store appears under its label after the built-ins]]
  it('shows a registered store under its label after the built-in groups', async () => {
    registerStores([
      {
        name: 'fixture',
        label: 'Fixture\nStore',
        command: answeringStore(twoHits),
      },
    ]);
    const defaults = await DEFAULT_STORES();
    expect(defaults.map((store) => store.name)).toEqual([
      'cq',
      'bd',
      'claude-memory',
      'fixture',
    ]);
    const stores = defaults.map((store) =>
      store.label === undefined ? fakeBuiltInStore(store.name) : store,
    );
    const output = await federateTags(docs, { projectRoot: '/tmp', stores });
    const lines = output!.split('\n');
    const fixtureGroup = lines.indexOf('Fixture Store:');
    expect(fixtureGroup).toBeGreaterThan(lines.indexOf('Claude Code memory:'));
    expect(lines.slice(fixtureGroup + 1)).toEqual([
      '- "first fixture hit" -> "one"',
      '- "second fixture hit" -> "two"',
    ]);
  });

  // @lat: [[fork-external-stores#Bad output yields no hits from that store]]
  it('drops output that is not JSON or not an array of hits', async () => {
    registerStores([
      { name: 'not-json', label: 'Not JSON', command: answeringStore('hello') },
      {
        name: 'bad-shape',
        label: 'Bad Shape',
        command: answeringStore(JSON.stringify([{ key: 1, title: 'x' }, 'y'])),
      },
      { name: 'object', label: 'Object', command: answeringStore('{}') },
    ]);
    const stores = [fakeBuiltInStore('bd'), ...externalStores()];
    expect(stores).toHaveLength(4);
    const output = await federateTags(docs, { projectRoot: '/tmp', stores });
    expect(output).toContain('bd memories:\n- "bd hit"');
    expect(output).not.toContain('Not JSON');
    expect(output).not.toContain('Bad Shape');
    expect(output).not.toContain('Object:');
  });

  // @lat: [[fork-external-stores#Wrongly shaped hits are dropped and the rest capped at the limit]]
  it('keeps only well-shaped hits, up to the limit', async () => {
    registerStores([
      {
        name: 'mixed',
        label: 'Mixed',
        command: answeringStore(
          JSON.stringify([
            { key: 'k0', title: 'no score', detail: '' },
            { key: 'k1', title: 'a', detail: '', score: 3 },
            { key: 'k2', title: 'b', detail: 'x', score: 2 },
            { key: 'k3', title: 'c', detail: 'y', score: 1 },
          ]),
        ),
      },
    ]);
    const [store] = externalStores();
    const hits = await store.query({ ...query, limit: 2 });
    expect(hits).toEqual([
      { store: 'mixed', key: 'k1', title: 'a', detail: '', score: 3 },
      { store: 'mixed', key: 'k2', title: 'b', detail: 'x', score: 2 },
    ]);
  });

  // @lat: [[fork-external-stores#A non-zero exit yields no hits]]
  it('returns no hits when the command exits non-zero', async () => {
    registerStores([
      {
        name: 'failing',
        label: 'Failing',
        command: answeringStore(twoHits, { exitCode: 1 }),
      },
    ]);
    const [store] = externalStores();
    expect(await store.query(query)).toEqual([]);
  });

  // @lat: [[fork-external-stores#A store past its timeout is abandoned]]
  it('abandons a store that runs past timeout_ms', async () => {
    const pidFile = join(tempDir(), 'pid');
    registerStores([
      {
        name: 'slow',
        label: 'Slow',
        command: silentStore(pidFile),
        timeout_ms: 500,
      },
    ]);
    const [store] = externalStores();
    const start = Date.now();
    expect(await store.query(query)).toEqual([]);
    expect(Date.now() - start).toBeLessThan(2000);
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(await waitFor(() => !processIsAlive(pid), 1000)).toBe(true);
  });

  // @lat: [[fork-external-stores#The federation deadline kills a store child]]
  it('kills a store child when the federation deadline passes', async () => {
    const pidFile = join(tempDir(), 'pid');
    registerStores([
      {
        name: 'silent',
        label: 'Silent',
        command: silentStore(pidFile),
        timeout_ms: 10000,
      },
    ]);
    const start = Date.now();
    const output = await federateTags(docs, {
      projectRoot: '/tmp',
      stores: externalStores(),
      deadlineMs: 1000,
    });
    expect(output).toBeNull();
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(await waitFor(() => !processIsAlive(pid), 1500)).toBe(true);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  // @lat: [[fork-external-stores#An invalid config leaves the built-ins working]]
  it('keeps the built-ins and does not exit when config.json is invalid', async () => {
    const configHome = tempDir();
    mkdirSync(join(configHome, 'lat'));
    writeFileSync(join(configHome, 'lat', 'config.json'), '{ not json');
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const stores = await DEFAULT_STORES();
    expect(stores.map((store) => store.name)).toEqual([
      'cq',
      'bd',
      'claude-memory',
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  // @lat: [[fork-external-stores#Malformed and built-in named entries are ignored]]
  it('ignores malformed entries and entries named after a built-in', async () => {
    const command = answeringStore(twoHits);
    registerStores([
      { name: 'bd', label: 'Fake bd', command },
      { name: 'bad name', label: 'Spaces', command },
      { name: 'no-label', command },
      { name: 'no-command', label: 'No command', command: [] },
      {
        name: 'callers-only',
        label: 'Callers',
        command,
        operations: ['callers'],
      },
      { name: 'good', label: 'Good', command },
      { name: 'good', label: 'Duplicate', command },
    ]);
    expect(externalStores().map((store) => store.name)).toEqual(['good']);
    const stores = await DEFAULT_STORES();
    expect(stores.filter((store) => store.name === 'bd')).toHaveLength(1);
    expect(stores.find((store) => store.name === 'bd')?.label).toBeUndefined();
  });

  // @lat: [[fork-external-stores#The test environment hides the user config]]
  it('reads no user stores under forkTestEnvironment', async () => {
    expect(process.env.XDG_CONFIG_HOME).toContain(
      join(tmpdir(), 'lat-test-config-'),
    );
    expect(existsSync(getConfigPath())).toBe(false);
    const stores = await DEFAULT_STORES();
    expect(stores.map((store) => store.name)).toEqual([
      'cq',
      'bd',
      'claude-memory',
    ]);
  });

  // @lat: [[fork-external-stores#Terms reach the store verbatim with no shell]]
  it('passes terms verbatim on stdin and never runs a shell', async () => {
    const workDir = tempDir();
    const stdinFile = join(workDir, 'stdin.json');
    registerStores([
      {
        name: 'recorder',
        label: 'Recorder',
        command: [...answeringStore('[]', { stdinFile }), '$(touch pwned)'],
      },
    ]);
    const [store] = externalStores();
    const terms = ['$(touch pwned)', '`touch pwned`'];
    await store.query({ terms, projectRoot: workDir, limit: 3 });
    expect(JSON.parse(readFileSync(stdinFile, 'utf-8'))).toEqual({
      operation: 'query',
      terms,
      projectRoot: workDir,
      limit: 3,
    });
    expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false);
    expect(existsSync(join(workDir, 'pwned'))).toBe(false);
  });
});
