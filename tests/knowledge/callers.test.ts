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
import { rmDirBestEffort } from '../util.js';
import { findCallers } from '../../src/knowledge/callers.js';

const providerScript = join(__dirname, '../fixtures/callers-provider.cjs');
const dirsToClean: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-callers-'));
  dirsToClean.push(dir);
  return dir;
}

/** Registers one store that runs the fixture provider. */
function registerProvider(
  output: string,
  options: {
    exitCode?: number;
    operations?: string[];
    timeoutMs?: number;
    command?: string[];
  } = {},
): { stdinFile: string } {
  const stdinFile = join(tempDir(), 'stdin.json');
  const command = options.command ?? [
    process.execPath,
    providerScript,
    stdinFile,
    output,
    String(options.exitCode ?? 0),
  ];
  registerStores([
    {
      name: 'fixture',
      label: 'Fixture',
      command,
      operations: options.operations ?? ['query', 'callers'],
      timeout_ms: options.timeoutMs,
    },
  ]);
  return { stdinFile };
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

const symbol = { file: 'src/auth.rb', name: 'User#login' };
const answer = (callers: unknown[]) => JSON.stringify([{ symbol, callers }]);
const caller = { file: 'src/app.rb', name: 'App#run', line: 7 };

describe('external callers lookup', () => {
  // @lat: [[fork-external-callers#Callers are keyed by file and name]]
  it('returns the provider callers keyed by file#name', async () => {
    registerProvider(answer([caller]));
    const result = await findCallers('/tmp', [symbol]);
    expect([...result]).toEqual([['src/auth.rb#User#login', [caller]]]);
  });

  // @lat: [[fork-external-callers#The request has the documented shape]]
  it('writes the documented request to stdin', async () => {
    const { stdinFile } = registerProvider(answer([]));
    await findCallers('/tmp/proj', [symbol], { depth: 2 });
    expect(JSON.parse(readFileSync(stdinFile, 'utf-8'))).toEqual({
      operation: 'callers',
      projectRoot: '/tmp/proj',
      symbols: [symbol],
      depth: 2,
    });
  });

  // @lat: [[fork-external-callers#Without a callers provider the result is empty]]
  it('returns an empty map and runs nothing without a callers provider', async () => {
    const none = await findCallers('/tmp', [symbol]);
    expect(none.size).toBe(0);
    const { stdinFile } = registerProvider(answer([caller]), {
      operations: ['query'],
    });
    const queryOnly = await findCallers('/tmp', [symbol]);
    expect(queryOnly.size).toBe(0);
    expect(existsSync(stdinFile)).toBe(false);
  });

  // @lat: [[fork-external-callers#Failures give an empty result]]
  it('returns an empty map for bad JSON, a non-zero exit and a timeout', async () => {
    registerProvider('not json');
    expect((await findCallers('/tmp', [symbol])).size).toBe(0);
    registerProvider(answer([caller]), { exitCode: 1 });
    expect((await findCallers('/tmp', [symbol])).size).toBe(0);
    registerProvider('', {
      timeoutMs: 100,
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    });
    expect((await findCallers('/tmp', [symbol])).size).toBe(0);
  });

  // @lat: [[fork-external-callers#Wrongly shaped entries are skipped]]
  it('skips entries and callers with the wrong shape', async () => {
    registerProvider(
      JSON.stringify([
        { symbol, callers: [caller, { file: 'x.rb', name: 'X' }, 'y'] },
        { symbol: { file: 'a.rb' }, callers: [caller] },
        { symbol: { file: 'b.rb', name: 'B' }, callers: 'nope' },
        'z',
      ]),
    );
    const result = await findCallers('/tmp', [symbol]);
    expect([...result]).toEqual([['src/auth.rb#User#login', [caller]]]);
  });

  // @lat: [[fork-external-callers#Callers outside the project are dropped]]
  it('drops callers with an absolute file or a .. segment', async () => {
    registerProvider(
      answer([
        { file: '/etc/passwd', name: 'a', line: 1 },
        { file: '../x.rb', name: 'b', line: 1 },
        { file: 'src/../../x.rb', name: 'c', line: 1 },
        { file: 'C:\\x.rb', name: 'd', line: 1 },
        caller,
      ]),
    );
    const result = await findCallers('/tmp', [symbol]);
    expect(result.get('src/auth.rb#User#login')).toEqual([caller]);
  });
});
