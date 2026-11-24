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
  rows: Array<{
    qnPrefix: string;
    file: string;
    name: string;
    lines: string;
    label?: string;
  }>,
): string {
  return JSON.stringify({
    cols: ['name', 'label', 'lines', 'in', 'out'],
    groups: rows.map((row) => ({
      qn_prefix: row.qnPrefix,
      file: row.file,
      rows: [[row.name, row.label ?? 'Function', row.lines, 0, 0]],
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

/** A trace_path result in the shape of CBM's `--format json` output. */
function traceOutput(
  callers: Array<{ qnPrefix: string; name: string; hop?: number }>,
): string {
  return JSON.stringify({
    function: 'x',
    direction: 'inbound',
    callers_total: callers.length,
    callers: {
      cols: ['name', 'hop'],
      groups: callers.map((caller) => ({
        qn_prefix: caller.qnPrefix,
        rows: [[caller.name, caller.hop ?? 1]],
      })),
    },
  });
}

/** A node the fake finds when searching by qualified name. */
type FakeNode = {
  qn_prefix: string;
  file: string;
  name: string;
  label: string;
  lines: string;
};

type RunOptions = {
  fakePath?: string;
  projects?: string;
  searches?: Record<string, string>;
  nodes?: FakeNode[];
  traces?: Record<string, string>;
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
      LAT_FIXTURE_NODES: JSON.stringify(options.nodes ?? []),
      LAT_FIXTURE_TRACES: JSON.stringify(options.traces ?? {}),
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

  // @lat: [[fork-codebase-memory-store#Only query and callers are answered]]
  it('prints [] for an operation other than query and callers', () => {
    const { stdout, status, argvCalls } = runAdapter({
      operation: 'stats',
      projectRoot,
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(argvCalls).toEqual([]);
  });
});

function callersRequest(
  symbols: Array<{ file: string; name: string }>,
  depth = 1,
) {
  return { operation: 'callers', projectRoot, symbols, depth };
}

const loginSymbol = { file: 'src/auth.ts', name: 'login' };
const loginNode = {
  qnPrefix: 'my-project.src.auth',
  file: 'src/auth.ts',
  name: 'login',
  lines: '4-9',
};
const loginQualifiedName = 'my-project.src.auth.login';
const runNode: FakeNode = {
  qn_prefix: 'my-project.src.app',
  file: 'src/app.ts',
  name: 'run',
  label: 'Function',
  lines: '7-12',
};
const startNode: FakeNode = {
  qn_prefix: 'my-project.src.app.Server',
  file: 'src/app.ts',
  name: 'start',
  label: 'Method',
  lines: '20-30',
};

describe('codebase-memory-mcp store adapter callers', () => {
  // @lat: [[fork-codebase-memory-store#Callers come from trace_path]]
  it('maps trace_path callers to file, name and line', () => {
    const { stdout, status } = runAdapter(callersRequest([loginSymbol], 2), {
      searches: { '^login$': searchOutput([loginNode]) },
      traces: {
        [loginQualifiedName]: traceOutput([
          { qnPrefix: 'my-project.src.app', name: 'run' },
          { qnPrefix: 'my-project.src.app.Server', name: 'start', hop: 2 },
        ]),
      },
      nodes: [startNode, runNode],
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        symbol: loginSymbol,
        callers: [
          { file: 'src/app.ts', name: 'run', line: 7 },
          { file: 'src/app.ts', name: 'Server#start', line: 20 },
        ],
      },
    ]);
  });

  // @lat: [[fork-codebase-memory-store#A callers request passes separate argv entries]]
  it('looks up the symbol in its file, traces inbound and finds the callers', () => {
    const { argvCalls } = runAdapter(callersRequest([loginSymbol], 3), {
      searches: { '^login$': searchOutput([loginNode]) },
      traces: {
        [loginQualifiedName]: traceOutput([
          { qnPrefix: 'my-project.src.app', name: 'run' },
        ]),
      },
      nodes: [runNode],
    });
    expect(argvCalls).toEqual([
      ['cli', 'list_projects', '--format', 'json'],
      [
        'cli',
        'search_graph',
        '--project',
        'my-project',
        '--name-pattern',
        '^login$',
        '--file-pattern',
        'src/auth.ts',
        '--format',
        'json',
      ],
      [
        'cli',
        'trace_path',
        '--project',
        'my-project',
        '--function-name',
        loginQualifiedName,
        '--direction',
        'inbound',
        '--depth',
        '3',
        '--format',
        'json',
      ],
      [
        'cli',
        'search_graph',
        '--project',
        'my-project',
        '--qn-pattern',
        '^(my-project\\.src\\.app\\.run)$',
        '--limit',
        '1',
        '--format',
        'json',
      ],
    ]);
  });

  // @lat: [[fork-codebase-memory-store#A class name picks the method]]
  it('tells a method from a same-name function in one file', () => {
    const topLevel = {
      qnPrefix: 'my-project.src.greeter',
      file: 'src/greeter.rb',
      name: 'greet',
      lines: '3-5',
    };
    const method = {
      qnPrefix: 'my-project.src.greeter.Greeter',
      file: 'src/greeter.rb',
      name: 'greet',
      lines: '20-22',
      label: 'Method',
    };
    const { stdout } = runAdapter(
      callersRequest([
        { file: 'src/greeter.rb', name: 'Greeter#greet' },
        { file: 'src/greeter.rb', name: 'greet' },
      ]),
      {
        searches: { '^greet$': searchOutput([method, topLevel]) },
        traces: {
          'my-project.src.greeter.Greeter.greet': traceOutput([
            { qnPrefix: 'my-project.src.app', name: 'run' },
          ]),
          'my-project.src.greeter.greet': traceOutput([
            { qnPrefix: 'my-project.src.app.Server', name: 'start' },
          ]),
        },
        nodes: [runNode, startNode],
      },
    );
    const answers = JSON.parse(stdout) as Array<{
      symbol: { name: string };
      callers: Array<{ name: string }>;
    }>;
    expect(
      answers.map((answer) => [
        answer.symbol.name,
        answer.callers.map((caller) => caller.name),
      ]),
    ).toEqual([
      ['Greeter#greet', ['run']],
      ['greet', ['Server#start']],
    ]);
  });

  // @lat: [[fork-codebase-memory-store#An unknown symbol is omitted]]
  it('omits a symbol CBM cannot find in its file and answers the rest', () => {
    const otherFileNode = { ...loginNode, file: 'src/other.ts' };
    const { stdout, status } = runAdapter(
      callersRequest([
        { file: 'src/missing.ts', name: 'nothing' },
        { file: 'src/auth.ts', name: 'Login' },
        loginSymbol,
      ]),
      {
        searches: {
          '^login$': searchOutput([otherFileNode, loginNode]),
          '^Login$': searchOutput([loginNode]),
        },
        traces: { [loginQualifiedName]: traceOutput([]) },
      },
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ symbol: loginSymbol, callers: [] }]);
  });

  // @lat: [[fork-codebase-memory-store#A failing symbol is omitted]]
  it('omits a symbol whose trace_path fails and answers the rest', () => {
    const brokenSymbol = { file: 'src/auth.ts', name: 'logout' };
    const brokenNode = { ...loginNode, name: 'logout', lines: '11-14' };
    const { stdout, status } = runAdapter(
      callersRequest([brokenSymbol, loginSymbol]),
      {
        searches: {
          '^logout$': searchOutput([brokenNode]),
          '^login$': searchOutput([loginNode]),
        },
        traces: {
          [loginQualifiedName]: traceOutput([
            { qnPrefix: 'my-project.src.app', name: 'run' },
          ]),
        },
        nodes: [runNode],
      },
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        symbol: loginSymbol,
        callers: [{ file: 'src/app.ts', name: 'run', line: 7 }],
      },
    ]);
  });

  // @lat: [[fork-codebase-memory-store#Only the first four symbols are answered]]
  it('answers only the first four symbols of a request, in order', () => {
    const names = ['one', 'two', 'three', 'four', 'five'];
    const searches: Record<string, string> = {};
    const traces: Record<string, string> = {};
    for (const name of names) {
      searches[`^${name}$`] = searchOutput([{ ...loginNode, name }]);
      traces[`my-project.src.auth.${name}`] = traceOutput([]);
    }
    const symbols = names.map((name) => ({ file: 'src/auth.ts', name }));
    const { stdout, argvCalls } = runAdapter(callersRequest(symbols), {
      searches,
      traces,
    });
    expect(JSON.parse(stdout)).toEqual(
      symbols.slice(0, 4).map((symbol) => ({ symbol, callers: [] })),
    );
    expect(argvCalls.some((argv) => argv.includes('^five$'))).toBe(false);
  });

  // @lat: [[fork-codebase-memory-store#A missing binary gives no callers]]
  it('prints [] and exits 0 when the binary is not on PATH', () => {
    const { stdout, status } = runAdapter(callersRequest([loginSymbol]), {
      fakePath: tempDir(),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  // @lat: [[fork-codebase-memory-store#Unreadable output gives no callers]]
  it('prints [] and exits 0 when the output is not JSON', () => {
    const searches = { '^login$': searchOutput([loginNode]) };
    for (const options of [
      { projects: 'not json' },
      { searches: { '^login$': '{"groups": 7}' } },
      { searches, traces: { [loginQualifiedName]: 'not json' } },
      { searches, traces: { [loginQualifiedName]: '{"status":"ambiguous"}' } },
    ]) {
      const { stdout, status } = runAdapter(
        callersRequest([loginSymbol]),
        options,
      );
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    }
  });

  // @lat: [[fork-codebase-memory-store#An unindexed project gives no callers]]
  it('prints [] and exits 0 when the project is not in list_projects', () => {
    const { stdout, status, argvCalls } = runAdapter(
      callersRequest([loginSymbol]),
      {
        projects: JSON.stringify({
          projects: [{ name: 'other', root_path: '/work/other' }],
        }),
      },
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(argvCalls).toHaveLength(1);
  });
});
