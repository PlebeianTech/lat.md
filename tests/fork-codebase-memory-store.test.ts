import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { rmDirBestEffort } from './util.js';

const repoRoot = join(__dirname, '..');
const adapterPath = join(
  repoRoot,
  'src/fork/adapters/codebase-memory-store.ts',
);
const fakeBinDir = join(__dirname, 'fixtures/codebase-memory-bin');
const projectRoot = '/work/my-project';
const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-cbm-store-'));
  dirsToClean.push(dir);
  return dir;
}

const projectsOutput = JSON.stringify({
  projects: [
    { name: 'other', root_path: '/work/other', branch: 'main' },
    { name: 'my-project', root_path: projectRoot, branch: 'main' },
  ],
});

/** A search_graph result in the shape of CBM's `--format json` output. */
function searchOutput(
  rows: Array<{ qnPrefix: string; file: string; name: string; lines: string }>,
): string {
  return JSON.stringify({
    cols: ['name', 'label', 'lines', 'in', 'out'],
    groups: rows.map((row) => ({
      qn_prefix: row.qnPrefix,
      file: row.file,
      rows: [[row.name, 'Function', row.lines, 0, 0]],
    })),
  });
}

const handleAlpha = {
  qnPrefix: 'my-project.src',
  file: 'src/a.ts',
  name: 'handleAlpha',
  lines: '10-20',
};
const alphaBeta = {
  qnPrefix: 'my-project.src',
  file: 'src/b.ts',
  name: 'alphaBeta',
  lines: '5-9',
};
const betaOnly = {
  qnPrefix: '',
  file: 'src/c.ts',
  name: 'betaOnly',
  lines: '3',
};

type RunOptions = {
  fakePath?: string;
  projects?: string;
  searches?: Record<string, string>;
};

/** Runs the adapter as a child process, with the fake binary on PATH. */
function runAdapter(request: object, options: RunOptions = {}) {
  const argvLog = join(tempDir(), 'argv.log');
  const result = spawnSync(process.execPath, ['--import', 'tsx', adapterPath], {
    cwd: repoRoot,
    input: JSON.stringify(request),
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: options.fakePath ?? fakeBinDir + delimiter + process.env.PATH,
      LAT_FIXTURE_ARGV_LOG: argvLog,
      LAT_FIXTURE_PROJECTS: options.projects ?? projectsOutput,
      LAT_FIXTURE_SEARCHES: JSON.stringify(options.searches ?? {}),
    },
  });
  const argvCalls = (() => {
    try {
      return readFileSync(argvLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  })();
  return { ...result, argvCalls };
}

function queryRequest(terms: string[], limit = 10) {
  return { operation: 'query', terms, projectRoot, limit };
}

describe('codebase-memory-mcp store adapter', () => {
  // @lat: [[fork-codebase-memory-store#Query hits come from search_graph]]
  it('maps search_graph rows to hits scored by matching terms', () => {
    const { stdout, status } = runAdapter(queryRequest(['alpha', 'beta']), {
      searches: {
        alpha: searchOutput([handleAlpha, alphaBeta]),
        beta: searchOutput([alphaBeta, betaOnly]),
      },
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        key: 'my-project.src.alphaBeta',
        title: 'my-project.src.alphaBeta',
        detail: 'src/b.ts:5',
        score: 2,
      },
      {
        key: 'my-project.src.handleAlpha',
        title: 'my-project.src.handleAlpha',
        detail: 'src/a.ts:10',
        score: 1,
      },
      { key: 'betaOnly', title: 'betaOnly', detail: 'src/c.ts:3', score: 1 },
    ]);
  });

  // @lat: [[fork-codebase-memory-store#A hit without a line number names the file]]
  it('gives the file alone when CBM reports no line', () => {
    const { stdout } = runAdapter(queryRequest(['gamma']), {
      searches: {
        gamma: searchOutput([
          {
            qnPrefix: 'my-project.src',
            file: 'src/g.ts',
            name: 'g',
            lines: '',
          },
        ]),
      },
    });
    expect(JSON.parse(stdout)).toEqual([
      {
        key: 'my-project.src.g',
        title: 'my-project.src.g',
        detail: 'src/g.ts',
        score: 1,
      },
    ]);
  });

  // @lat: [[fork-codebase-memory-store#Hits are capped at the limit]]
  it('returns at most limit hits', () => {
    const { stdout } = runAdapter(queryRequest(['alpha', 'beta'], 2), {
      searches: {
        alpha: searchOutput([handleAlpha, alphaBeta]),
        beta: searchOutput([alphaBeta, betaOnly]),
      },
    });
    const hits = JSON.parse(stdout) as Array<{ key: string }>;
    expect(hits.map((hit) => hit.key)).toEqual([
      'my-project.src.alphaBeta',
      'my-project.src.handleAlpha',
    ]);
  });

  // @lat: [[fork-codebase-memory-store#Arguments reach the binary as separate entries]]
  it('passes separate argv entries with each term regex-escaped', () => {
    const { argvCalls } = runAdapter(queryRequest(['a.b*', 'two words']));
    expect(argvCalls).toEqual([
      ['cli', 'list_projects', '--format', 'json'],
      [
        'cli',
        'search_graph',
        '--project',
        'my-project',
        '--name-pattern',
        'a\\.b\\*',
        '--format',
        'json',
      ],
      [
        'cli',
        'search_graph',
        '--project',
        'my-project',
        '--name-pattern',
        'two words',
        '--format',
        'json',
      ],
    ]);
  });

  // @lat: [[fork-codebase-memory-store#A missing binary gives no hits]]
  it('prints [] and exits 0 when the binary is not on PATH', () => {
    const { stdout, status } = runAdapter(queryRequest(['alpha']), {
      fakePath: tempDir(),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  // @lat: [[fork-codebase-memory-store#An unindexed project gives no hits]]
  it('prints [] and exits 0 when the project is not in list_projects', () => {
    const { stdout, status, argvCalls } = runAdapter(queryRequest(['alpha']), {
      projects: JSON.stringify({
        projects: [{ name: 'other', root_path: '/work/other' }],
      }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(argvCalls).toHaveLength(1);
  });

  // @lat: [[fork-codebase-memory-store#Unreadable output gives no hits]]
  it('prints [] and exits 0 when the output is not JSON', () => {
    const garbageProjects = runAdapter(queryRequest(['alpha']), {
      projects: 'not json',
    });
    expect(garbageProjects.status).toBe(0);
    expect(JSON.parse(garbageProjects.stdout)).toEqual([]);

    const garbageSearch = runAdapter(queryRequest(['alpha']), {
      searches: { alpha: '{"groups": 7}' },
    });
    expect(garbageSearch.status).toBe(0);
    expect(JSON.parse(garbageSearch.stdout)).toEqual([]);
  });

  // @lat: [[fork-codebase-memory-store#Only the query operation is answered]]
  it('prints [] for an operation other than query', () => {
    const { stdout, status, argvCalls } = runAdapter({
      operation: 'callers',
      projectRoot,
      symbols: [],
      depth: 1,
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(argvCalls).toEqual([]);
  });
});
