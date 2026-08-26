import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGraph,
  formatGraphMermaid,
  formatGraphDot,
  formatGraphJson,
  diffGraphs,
  type GraphSourceFile,
} from '../src/graph-export.js';

const casesDir = join(import.meta.dirname, 'cases');
const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

function caseDir(name: string): string {
  return join(casesDir, name);
}

function runCli(
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('graph-basic', () => {
  // @lat: [[graph#Exports every section and edge as JSON]]
  it('exports every section and every edge as JSON', () => {
    const result = runCli(caseDir('graph-basic'), [
      'graph',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    const graph = JSON.parse(result.stdout);

    const sectionLabels = graph.nodes
      .filter((n: { type: string }) => n.type === 'section')
      .map((n: { label: string }) => n.label);
    expect(sectionLabels).toEqual(
      expect.arrayContaining(['Tests', 'Login', 'Rejects bad password']),
    );

    const docNode = graph.nodes.find(
      (n: { type: string; file?: string }) =>
        n.type === 'document' && n.file === 'lat.md/tests.md',
    );
    expect(docNode.mode).toBe('reference');
    expect(docNode.status).toBe('human-reviewed');

    const tagNodes = graph.nodes.filter(
      (n: { type: string }) => n.type === 'tag',
    );
    expect(tagNodes.map((n: { label: string }) => n.label).sort()).toEqual([
      'alpha',
      'beta',
    ]);

    const codeRefEdges = graph.edges.filter(
      (e: { type: string }) => e.type === 'code-ref',
    );
    expect(codeRefEdges.length).toBeGreaterThan(0);

    const wikilinkEdges = graph.edges.filter(
      (e: { type: string }) => e.type === 'wikilink',
    );
    expect(wikilinkEdges.length).toBeGreaterThan(0);

    const containsEdges = graph.edges.filter(
      (e: { type: string }) => e.type === 'contains',
    );
    expect(containsEdges.length).toBeGreaterThan(0);
  });

  // @lat: [[graph#Renders mermaid output]]
  it('renders mermaid output', () => {
    const result = runCli(caseDir('graph-basic'), [
      'graph',
      '--format',
      'mermaid',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('flowchart TD');
    expect(result.stdout).toContain('-->|');
  });

  // @lat: [[graph#Renders dot output]]
  it('renders dot output', () => {
    const result = runCli(caseDir('graph-basic'), ['graph', '--format', 'dot']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('digraph lat {');
  });

  // @lat: [[graph#Rejects an unknown format]]
  it('rejects an unknown format', () => {
    const result = runCli(caseDir('graph-basic'), [
      'graph',
      '--format',
      'yaml',
    ]);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('graph-untrusted-title', () => {
  // @lat: [[graph#Untrusted heading survives every format]]
  it('does not break json, mermaid, or dot output on a quoted heading', () => {
    for (const format of ['json', 'mermaid', 'dot']) {
      const result = runCli(caseDir('graph-untrusted-title'), [
        'graph',
        '--format',
        format,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    }

    const json = runCli(caseDir('graph-untrusted-title'), [
      'graph',
      '--format',
      'json',
    ]);
    const graph = JSON.parse(json.stdout);
    const section = graph.nodes.find(
      (n: { type: string }) => n.type === 'section',
    );
    expect(section.label).toContain('quotes');

    const mermaid = runCli(caseDir('graph-untrusted-title'), [
      'graph',
      '--format',
      'mermaid',
    ]);
    // Every raw quote inside a mermaid label must be escaped so it cannot
    // terminate the quoted label early.
    expect(mermaid.stdout).toContain('#quot;');
  });
});

describe('git history', () => {
  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lat-graph-'));
    mkdirSync(join(dir, 'lat.md'), { recursive: true });
    const run = (args: string[]) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });

    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    writeFileSync(
      join(dir, 'lat.md', 'doc.md'),
      '# Doc\n\nInitial overview.\n\n## Old Section\n\nThis section will be deleted later.\n',
    );
    run(['add', '.']);
    run(['commit', '-q', '-m', 'first']);

    // A few filler commits so HEAD~2 is meaningfully in the past.
    writeFileSync(
      join(dir, 'lat.md', 'doc.md'),
      '# Doc\n\nInitial overview.\n\n## Old Section\n\nThis section will be deleted later.\n\n## Filler\n\nFiller section.\n',
    );
    run(['add', '.']);
    run(['commit', '-q', '-m', 'second']);

    writeFileSync(
      join(dir, 'lat.md', 'doc.md'),
      '# Doc\n\nInitial overview.\n\n## Filler\n\nFiller section.\n',
    );
    run(['add', '.']);
    run(['commit', '-q', '-m', 'delete section']);

    return dir;
  }

  // @lat: [[graph#Reconstructing the graph at a git revision#Differs from the working tree]]
  it('reconstructs the graph at a revision, differing from the working tree', () => {
    const dir = initRepo();
    try {
      const atOld = runCli(dir, [
        'graph',
        '--format',
        'json',
        '--at',
        'HEAD~2',
      ]);
      const atNew = runCli(dir, ['graph', '--format', 'json']);
      expect(atOld.exitCode).toBe(0);
      expect(atNew.exitCode).toBe(0);
      expect(atOld.stdout).not.toEqual(atNew.stdout);

      const oldGraph = JSON.parse(atOld.stdout);
      const oldLabels = oldGraph.nodes
        .filter((n: { type: string }) => n.type === 'section')
        .map((n: { label: string }) => n.label);
      expect(oldLabels).toContain('Old Section');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // @lat: [[graph#Reconstructing the graph at a git revision#--since names a removed section]]
  it('--since names a section that was deleted', () => {
    const dir = initRepo();
    try {
      const result = runCli(dir, ['graph', '--since', 'HEAD~2']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('removed');
      expect(result.stdout).toContain('Old Section');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graph-export unit', () => {
  // @lat: [[graph#graph-export unit tests#diffGraphs reports added, removed, and changed sections]]
  it('diffGraphs reports added, removed, and changed sections', async () => {
    const before: GraphSourceFile[] = [
      {
        relPath: 'lat.md/x.md',
        content: '# X\n\nOverview.\n\n## Gone\n\nWill be removed.\n',
      },
    ];
    const after: GraphSourceFile[] = [
      {
        relPath: 'lat.md/x.md',
        content: '# X\n\nOverview.\n\n## New\n\nAdded later.\n',
      },
    ];
    const beforeGraph = await buildGraph(before, '/tmp/does-not-matter', false);
    const afterGraph = await buildGraph(after, '/tmp/does-not-matter', false);
    const diff = diffGraphs(beforeGraph, afterGraph);
    expect(diff.removed.some((id) => id.includes('Gone'))).toBe(true);
    expect(diff.added.some((id) => id.includes('New'))).toBe(true);
  });

  // @lat: [[graph#graph-export unit tests#Formatters succeed on a quoted, control-charred label]]
  it('formatters all succeed on a graph with a quoted, control-charred label', async () => {
    const files: GraphSourceFile[] = [
      {
        relPath: 'lat.md/x.md',
        content:
          '# X\n\nOverview with "quotes" and  control chars.\n\n## Section "quoted"\n\nBody.\n',
      },
    ];
    const graph = await buildGraph(files, '/tmp/does-not-matter', false);
    expect(() => formatGraphJson(graph)).not.toThrow();
    expect(() => formatGraphMermaid(graph)).not.toThrow();
    expect(() => formatGraphDot(graph)).not.toThrow();
    const mermaid = formatGraphMermaid(graph);
    expect(mermaid).toContain('#quot;');
  });
});
