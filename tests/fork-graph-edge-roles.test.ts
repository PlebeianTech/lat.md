import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirBestEffort } from './util.js';
import {
  buildGraph,
  diffGraphs,
  formatGraphJson,
  formatGraphMermaid,
  formatGraphDot,
  type GraphSourceFile,
  type GraphEdge,
  type GraphEdgeRole,
} from '../src/graph-export.js';

const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

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

describe('fork graph export edge roles: contains and tag edges', () => {
  const fixtureFiles: GraphSourceFile[] = [
    {
      relPath: 'lat.md/guide.md',
      content: `---
lat:
  tags: [alpha, beta]
---
# Guide

Top level guide overview.

## Child Section

Child section details.
`,
    },
  ];

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Contains hierarchy edges omit role]]
  it('leaves role undefined on document and section containment edges', async () => {
    const graph = await buildGraph(fixtureFiles, '/fake/project', false);
    const containsEdges = graph.edges.filter((e) => e.type === 'contains');
    expect(containsEdges.length).toBeGreaterThan(0);
    for (const edge of containsEdges) {
      expect(edge.role).toBeUndefined();
    }
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Tag edges omit role]]
  it('leaves role undefined on document tag edges', async () => {
    const graph = await buildGraph(fixtureFiles, '/fake/project', false);
    const tagEdges = graph.edges.filter((e) => e.type === 'tag');
    expect(tagEdges.length).toBe(2);
    for (const edge of tagEdges) {
      expect(edge.role).toBeUndefined();
    }
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Contains and tag edges omit role in json]]
  it('omits role key in serialized json for contains and tag edges', async () => {
    const graph = await buildGraph(fixtureFiles, '/fake/project', false);
    const jsonStr = formatGraphJson(graph);
    const parsed = JSON.parse(jsonStr);
    const containsEdges = parsed.edges.filter(
      (e: { type: string }) => e.type === 'contains',
    );
    const tagEdges = parsed.edges.filter(
      (e: { type: string }) => e.type === 'tag',
    );
    expect(containsEdges.length).toBeGreaterThan(0);
    expect(tagEdges.length).toBeGreaterThan(0);
    for (const edge of [...containsEdges, ...tagEdges]) {
      expect(edge).not.toHaveProperty('role');
    }
  });
});

describe('fork graph export edge roles: wikilink edge classification', () => {
  const specFiles: GraphSourceFile[] = [
    {
      relPath: 'lat.md/specs.md',
      content: `---
lat:
  require-code-mention: true
---
# Specs

Test specification overview.

## Token Spec

Token spec description.
`,
    },
    {
      relPath: 'lat.md/tests/auth.md',
      content: `# Auth Tests

Auth test specifications under tests directory.

## Login Verification

Verifies login behavior.
`,
    },
    {
      relPath: 'lat.md/knowledge/tests/runner.md',
      content: `# Runner Tests

Runner test specifications under knowledge tests directory.

## Process Runner

Verifies runner process execution.
`,
    },
    {
      relPath: 'lat.md/architecture.md',
      content: `# Architecture

General architecture document.

## Overview

Architecture overview description.
`,
    },
    {
      relPath: 'lat.md/how-to/tests/guide.md',
      content: `# Guide

Guide overview for testing procedures.

## Strategy

Testing strategy description.
`,
    },
    {
      relPath: 'lat.md/consumer.md',
      content: `# Consumer

Consumer document with links.

## Links

Reference to [[specs#Token Spec]], to [[auth#Login Verification]], to [[runner#Process Runner]], to [[architecture#Overview]], to [[guide#Strategy]], and to source symbol [[src/app.ts#startServer]] and external [[unresolved/external/target]].
`,
    },
  ];

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Wikilink targeting test spec frontmatter receives test spec ref]]
  it('assigns test-spec-ref to wikilinks targeting documents with require-code-mention frontmatter', async () => {
    const graph = await buildGraph(specFiles, '/fake/project', false);
    const edge = graph.edges.find(
      (e) => e.type === 'wikilink' && e.to.includes('specs#Specs#Token Spec'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('test-spec-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Wikilink targeting test directory doc receives test spec ref]]
  it('assigns test-spec-ref to wikilinks targeting documents under tests/ directory path', async () => {
    const graph = await buildGraph(specFiles, '/fake/project', false);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'wikilink' &&
        e.to.includes('tests/auth#Auth Tests#Login Verification'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('test-spec-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Wikilink targeting knowledge tests doc receives test spec ref]]
  it('assigns test-spec-ref to wikilinks targeting documents under knowledge/tests/ directory path', async () => {
    const graph = await buildGraph(specFiles, '/fake/project', false);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'wikilink' &&
        e.to.includes('runner#Runner Tests#Process Runner'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('test-spec-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Wikilink targeting standard document receives section ref]]
  it('assigns section-ref to wikilinks targeting non-test documentation sections', async () => {
    const graph = await buildGraph(specFiles, '/fake/project', false);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'wikilink' &&
        e.to.includes('architecture#Architecture#Overview'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('section-ref');

    // Document with /tests/ in path that is not lat.md/tests/, lat.md/knowledge/tests/, or tests/ is NOT a test spec
    const guideEdge = graph.edges.find(
      (e) =>
        e.type === 'wikilink' &&
        e.to.includes('guide#Guide#Strategy'),
    );
    expect(guideEdge).toBeDefined();
    expect(guideEdge?.role).toBe('section-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Wikilink targeting source symbol receives symbol ref]]
  it('assigns symbol-ref to wikilinks targeting repository source symbols', async () => {
    const graph = await buildGraph(specFiles, '/fake/project', false);
    const edge = graph.edges.find(
      (e) => e.type === 'wikilink' && e.to === 'code:src/app.ts#startServer',
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('symbol-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Wikilink targeting unresolved code target receives symbol ref]]
  it('assigns symbol-ref to wikilinks targeting unresolvable code targets', async () => {
    const graph = await buildGraph(specFiles, '/fake/project', false);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'wikilink' && e.to === 'code:unresolved/external/target',
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('symbol-ref');
  });
});

describe('fork graph export edge roles: code-ref edge classification', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmDirBestEffort(tempDir);
    }
  });

  function setupCodeRefRepo(): { tempDir: string; files: GraphSourceFile[] } {
    tempDir = mkdtempSync(join(tmpdir(), 'lat-code-ref-roles-'));
    mkdirSync(join(tempDir, 'lat.md'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'tests'), { recursive: true });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });

    const specContent = `---
lat:
  require-code-mention: true
---
# Specs

Test specification document.

## Token Validation

Validates authentication tokens.
`;
    writeFileSync(join(tempDir, 'lat.md', 'specs.md'), specContent);

    const docContent = `# Architecture

Architecture document.

## Pipeline

Pipeline description.
`;
    writeFileSync(join(tempDir, 'lat.md', 'doc.md'), docContent);

    writeFileSync(
      join(tempDir, 'tests', 'auth.test.ts'),
      `// @lat: [[doc#Architecture#Pipeline]]\nexport function testAuth() {}\n`,
    );

    writeFileSync(
      join(tempDir, 'src', 'tests', 'helper.ts'),
      `// @lat: [[doc#Architecture#Pipeline]]\nexport function testHelper() {}\n`,
    );

    writeFileSync(
      join(tempDir, 'src', 'component.spec.ts'),
      `// @lat: [[doc#Architecture#Pipeline]]\nexport function specComponent() {}\n`,
    );

    writeFileSync(
      join(tempDir, 'src', 'app.ts'),
      `// @lat: [[doc#Architecture#Pipeline]]\n// @lat: [[specs#Specs#Token Validation]]\nexport function run() {}\n`,
    );

    writeFileSync(
      join(tempDir, 'tests', 'specs.test.ts'),
      `// @lat: [[specs#Specs#Token Validation]]\nexport function testSpec() {}\n`,
    );

    const files: GraphSourceFile[] = [
      { relPath: 'lat.md/specs.md', content: specContent },
      { relPath: 'lat.md/doc.md', content: docContent },
    ];

    return { tempDir, files };
  }

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Code ref from test file receives verifies role]]
  it('assigns verifies to code references originating from test files', async () => {
    const { tempDir: dir, files } = setupCodeRefRepo();
    const graph = await buildGraph(files, dir, true);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'code-ref' &&
        e.from.includes('tests/auth.test.ts') &&
        e.to.includes('doc#Architecture#Pipeline'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('verifies');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Code ref from nested test file receives verifies role]]
  it('assigns verifies to code references originating from nested test directories', async () => {
    const { tempDir: dir, files } = setupCodeRefRepo();
    const graph = await buildGraph(files, dir, true);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'code-ref' &&
        e.from.includes('src/tests/helper.ts') &&
        e.to.includes('doc#Architecture#Pipeline'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('verifies');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Code ref from test suffix file receives verifies role]]
  it('assigns verifies to code references originating from test suffix files', async () => {
    const { tempDir: dir, files } = setupCodeRefRepo();
    const graph = await buildGraph(files, dir, true);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'code-ref' &&
        e.from.includes('src/component.spec.ts') &&
        e.to.includes('doc#Architecture#Pipeline'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('verifies');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Code ref targeting test spec receives verifies role]]
  it('assigns verifies to code references in production code that target test specifications', async () => {
    const { tempDir: dir, files } = setupCodeRefRepo();
    const graph = await buildGraph(files, dir, true);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'code-ref' &&
        e.from.includes('src/app.ts') &&
        e.to.includes('specs#Specs#Token Validation'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('verifies');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Code ref from test file targeting test spec receives verifies role]]
  it('assigns verifies to code references in test files targeting test specifications', async () => {
    const { tempDir: dir, files } = setupCodeRefRepo();
    const graph = await buildGraph(files, dir, true);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'code-ref' &&
        e.from.includes('tests/specs.test.ts') &&
        e.to.includes('specs#Specs#Token Validation'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('verifies');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Code ref from production code receives implements role]]
  it('assigns implements to code references in production code targeting general sections', async () => {
    const { tempDir: dir, files } = setupCodeRefRepo();
    const graph = await buildGraph(files, dir, true);
    const edge = graph.edges.find(
      (e) =>
        e.type === 'code-ref' &&
        e.from.includes('src/app.ts') &&
        e.to.includes('doc#Architecture#Pipeline'),
    );
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('implements');
  });
});

describe('fork graph export edge roles: formatters and baseline preservation', () => {
  const mixedFiles: GraphSourceFile[] = [
    {
      relPath: 'lat.md/guide.md',
      content: `---
lat:
  tags: [core]
---
# Guide

Guide overview.

## Setup

Details linking to [[src/config.ts#loadConfig]].
`,
    },
  ];

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Baseline graph edge types remain preserved]]
  it('preserves existing GraphEdge.type values across all exported edges', async () => {
    const graph = await buildGraph(mixedFiles, '/fake/project', false);
    const validTypes = new Set(['contains', 'wikilink', 'code-ref', 'tag']);
    for (const edge of graph.edges) {
      expect(validTypes.has(edge.type)).toBe(true);
    }
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#JSON serialization includes role on semantic edges]]
  it('includes string role attributes in serialized JSON for classified edges', async () => {
    const graph = await buildGraph(mixedFiles, '/fake/project', false);
    const jsonStr = formatGraphJson(graph);
    const parsed = JSON.parse(jsonStr);
    const wikilink = parsed.edges.find(
      (e: { type: string }) => e.type === 'wikilink',
    );
    expect(wikilink).toBeDefined();
    expect(wikilink.role).toBe('symbol-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Mermaid formatter preserves edge type syntax]]
  it('formats Mermaid output using original edge types without syntax corruption', async () => {
    const graph = await buildGraph(mixedFiles, '/fake/project', false);
    const mermaid = formatGraphMermaid(graph);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('-->|contains|');
    expect(mermaid).toContain('-->|tag|');
    expect(mermaid).toContain('-->|wikilink|');
    expect(mermaid).not.toContain('-->|symbol-ref|');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Dot formatter preserves edge type syntax]]
  it('formats Graphviz DOT output using original edge types without syntax corruption', async () => {
    const graph = await buildGraph(mixedFiles, '/fake/project', false);
    const dot = formatGraphDot(graph);
    expect(dot).toContain('digraph lat {');
    expect(dot).toContain('[label="contains"]');
    expect(dot).toContain('[label="tag"]');
    expect(dot).toContain('[label="wikilink"]');
    expect(dot).not.toContain('[label="symbol-ref"]');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#CLI graph export outputs classified edge roles]]
  it('exports semantic edge roles accurately via CLI child process execution', () => {
    const casesDir = join(import.meta.dirname, 'cases');
    const result = runCli(join(casesDir, 'graph-basic'), [
      'graph',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    const graph = JSON.parse(result.stdout);
    const wikilinkEdges = graph.edges.filter(
      (e: { type: string }) => e.type === 'wikilink',
    );
    expect(wikilinkEdges.length).toBeGreaterThan(0);
    const symbolEdge = wikilinkEdges.find((e: { to: string }) =>
      e.to.startsWith('code:'),
    );
    expect(symbolEdge?.role).toBe('symbol-ref');
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Graph diffs remain unaffected by edge roles]]
  it('calculates graph diffs independently from edge role annotations', async () => {
    const before: GraphSourceFile[] = [
      {
        relPath: 'lat.md/a.md',
        content:
          '# A\n\nOverview.\n\n## Section\n\nContent linking to [[b#Other]].\n',
      },
    ];
    const after: GraphSourceFile[] = [
      {
        relPath: 'lat.md/a.md',
        content:
          '# A\n\nOverview.\n\n## Section\n\nContent linking to [[src/b.ts#func]].\n',
      },
    ];
    const gBefore = await buildGraph(before, '/fake/project', false);
    const gAfter = await buildGraph(after, '/fake/project', false);
    const diff = diffGraphs(gBefore, gAfter);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  // @lat: [[fork-graph-edge-roles#Fork Graph Edge Roles#Edge role literals exclude em dashes]]
  it('verifies all defined edge role literals contain zero em dashes and en dashes', () => {
    const roles: GraphEdgeRole[] = [
      'section-ref',
      'symbol-ref',
      'test-spec-ref',
      'implements',
      'verifies',
    ];
    for (const role of roles) {
      expect(role).not.toContain('\u2014');
      expect(role).not.toContain('\u2013');
    }
  });
});
