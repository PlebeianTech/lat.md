import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { plainStyler, type CmdContext } from '@plebeiantech/lat.md-core/context';
import type { Section, SectionMatch } from '@plebeiantech/lat.md-core/lattice-model';
import {
  formatSectionOutput,
  getSection,
  type SectionFound,
  type CodeBackRef,
} from '@plebeiantech/lat.md-core/cli/section';
import {
  classifyCodeRefRole,
  formatIncomingRefLocation,
  type CodeRefRole,
} from '@plebeiantech/lat.md-core/fork/section-edges';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const casesDir = join(import.meta.dirname, 'cases');
const caseDir = (name: string) => join(casesDir, name);
const latDir = (name: string) => join(caseDir(name), 'lat.md');

function testCtx(name: string): CmdContext {
  return {
    latDir: latDir(name),
    projectRoot: caseDir(name),
    styler: plainStyler,
    mode: 'cli',
  };
}

function makeMockSection(id: string, firstParagraph = 'Default overview summary.'): Section {
  const hashIdx = id.indexOf('#');
  const file = hashIdx === -1 ? id : id.slice(0, hashIdx);
  return {
    id,
    heading: id.split('#').pop() ?? id,
    depth: 1,
    file,
    filePath: file.endsWith('.md') ? file : `${file}.md`,
    children: [],
    startLine: 1,
    endLine: 10,
    firstParagraph,
  };
}

function makeMockFound(
  section: Section,
  incomingRefs: SectionMatch[] = [],
  codeRefs: CodeBackRef[] = [],
): SectionFound {
  return {
    kind: 'found',
    section,
    content: 'Quoted test section content.',
    status: null,
    outgoingRefs: [],
    outgoingSourceRefs: [],
    outgoingExternalRefs: [],
    incomingRefs,
    codeRefs,
  };
}

describe('classifyCodeRefRole', () => {
  // @lat: [[fork-section-edges#Fork Section Edges#Classify test directory prefixes]]
  it('classifies root test directory prefixes as test', () => {
    expect(classifyCodeRefRole('tests/foo.ts')).toBe('test');
    expect(classifyCodeRefRole('test/bar.py')).toBe('test');
    expect(classifyCodeRefRole('__tests__/baz.js')).toBe('test');
    expect(classifyCodeRefRole('spec/qux.rb')).toBe('test');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Classify nested test directories]]
  it('classifies nested test directories as test', () => {
    expect(classifyCodeRefRole('src/tests/helper.ts')).toBe('test');
    expect(classifyCodeRefRole('packages/core/test/fixture.js')).toBe('test');
    expect(classifyCodeRefRole('packages/server/__tests__/api.ts')).toBe('test');
    expect(classifyCodeRefRole('lib/spec/models/user_spec.rb')).toBe('test');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Classify test file suffix patterns]]
  it('classifies test file suffix patterns as test', () => {
    expect(classifyCodeRefRole('src/foo.test.ts')).toBe('test');
    expect(classifyCodeRefRole('lib/bar.spec.js')).toBe('test');
    expect(classifyCodeRefRole('src/components/button.test.tsx')).toBe('test');
    expect(classifyCodeRefRole('pkg/core.spec.mjs')).toBe('test');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Normalize path separators before role classification]]
  it('normalizes Windows backslashes before classifying role', () => {
    expect(classifyCodeRefRole('tests\\foo.ts')).toBe('test');
    expect(classifyCodeRefRole('src\\tests\\helper.ts')).toBe('test');
    expect(classifyCodeRefRole('src\\foo.test.ts')).toBe('test');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Classify production source files as code]]
  it('classifies standard implementation files as code', () => {
    expect(classifyCodeRefRole('src/index.ts')).toBe('code');
    expect(classifyCodeRefRole('lib/utils.py')).toBe('code');
    expect(classifyCodeRefRole('packages/core/src/lattice.ts')).toBe('code');
    expect(classifyCodeRefRole('app/controllers/user.rb')).toBe('code');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Similar substring paths without boundary segments return code]]
  it('classifies similar substring words without path boundaries as code', () => {
    expect(classifyCodeRefRole('src/testing/runner.ts')).toBe('code');
    expect(classifyCodeRefRole('src/tester.ts')).toBe('code');
    expect(classifyCodeRefRole('src/special.ts')).toBe('code');
    expect(classifyCodeRefRole('src/contest.ts')).toBe('code');
    expect(classifyCodeRefRole('src/specification.ts')).toBe('code');
  });
});

describe('formatIncomingRefLocation', () => {
  const root = '/repo';

  // @lat: [[fork-section-edges#Fork Section Edges#Format incoming location with file and positive line]]
  it('formats file path and positive line into parenthesized coordinate string', () => {
    expect(
      formatIncomingRefLocation(root, root, 'lat.md/knowledge/cli.md', 42),
    ).toBe(' (lat.md/knowledge/cli.md:42)');
    expect(formatIncomingRefLocation(root, root, 'lat.md/setup.md', 1)).toBe(
      ' (lat.md/setup.md:1)',
    );
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format incoming location appends missing markdown extension]]
  it('appends .md extension when file stem omits it', () => {
    expect(
      formatIncomingRefLocation(root, root, 'lat.md/knowledge/cli', 42),
    ).toBe(' (lat.md/knowledge/cli.md:42)');
    expect(formatIncomingRefLocation(root, root, 'lat.md/setup', 10)).toBe(
      ' (lat.md/setup.md:10)',
    );
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format incoming location calculates relative path from working directory]]
  it('computes relative path when cwd is a subfolder of projectRoot', () => {
    const cwd = join(root, 'packages', 'core');
    expect(
      formatIncomingRefLocation(root, cwd, 'lat.md/knowledge/cli.md', 42),
    ).toBe(' (../../lat.md/knowledge/cli.md:42)');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format incoming location returns empty string for missing file]]
  it('returns empty string when file is undefined or empty', () => {
    expect(formatIncomingRefLocation(root, root, undefined, 42)).toBe('');
    expect(formatIncomingRefLocation(root, root, '', 42)).toBe('');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format incoming location returns empty string for non positive line]]
  it('returns empty string when line number is zero, negative, or undefined', () => {
    expect(
      formatIncomingRefLocation(root, root, 'lat.md/knowledge/cli.md', undefined),
    ).toBe('');
    expect(formatIncomingRefLocation(root, root, 'lat.md/knowledge/cli.md', 0)).toBe(
      '',
    );
    expect(
      formatIncomingRefLocation(root, root, 'lat.md/knowledge/cli.md', -5),
    ).toBe('');
    expect(
      formatIncomingRefLocation(root, root, 'lat.md/knowledge/cli.md', NaN),
    ).toBe('');
  });
});

describe('formatSectionOutput integration', () => {
  const root = process.cwd();
  const mockCtx: CmdContext = {
    latDir: join(root, 'lat.md'),
    projectRoot: root,
    styler: plainStyler,
    mode: 'cli',
  };

  // @lat: [[fork-section-edges#Fork Section Edges#Format section output renders backlink citation coordinates]]
  it('renders citation coordinates on incoming section backlinks', () => {
    const section = makeMockSection('target#Target');
    const referring = makeMockSection('lat.md/links#Links', 'Summary of links.');
    const incoming: SectionMatch = {
      section: referring,
      reason: 'wiki link',
      citeFile: 'lat.md/links.md',
      citeLine: 12,
    };
    const found = makeMockFound(section, [incoming]);
    const output = stripAnsi(formatSectionOutput(mockCtx, found));

    expect(output).toContain('## Referenced by:');
    expect(output).toContain('* [[lat.md/links#Links]] (lat.md/links.md:12) — Summary of links.');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format section output preserves backlinks lacking citation coordinates]]
  it('omits coordinates when incoming references lack citation metadata', () => {
    const section = makeMockSection('target#Target');
    const referring = makeMockSection('lat.md/links#Links', 'Summary of links.');
    const incoming: SectionMatch = {
      section: referring,
      reason: 'wiki link',
    };
    const found = makeMockFound(section, [incoming]);
    const output = stripAnsi(formatSectionOutput(mockCtx, found));

    expect(output).toContain('## Referenced by:');
    expect(output).toContain('* [[lat.md/links#Links]] — Summary of links.');
    expect(output).not.toContain('()');
    expect(output).not.toContain('(undefined)');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format section output labels test code backlinks]]
  it('labels code backlinks from test files with [test]', () => {
    const section = makeMockSection('target#Target');
    const codeRef: CodeBackRef = {
      file: 'tests/foo.test.ts',
      line: 15,
      snippet: '// @lat: [[target#Target]]',
    };
    const found = makeMockFound(section, [], [codeRef]);
    const output = stripAnsi(formatSectionOutput(mockCtx, found));

    expect(output).toContain('## Referenced by code:');
    expect(output).toContain('* tests/foo.test.ts:15 [test]');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format section output labels production code backlinks]]
  it('labels code backlinks from production source files with [code]', () => {
    const section = makeMockSection('target#Target');
    const codeRef: CodeBackRef = {
      file: 'src/foo.ts',
      line: 25,
      snippet: '// @lat: [[target#Target]]',
    };
    const found = makeMockFound(section, [], [codeRef]);
    const output = stripAnsi(formatSectionOutput(mockCtx, found));

    expect(output).toContain('## Referenced by code:');
    expect(output).toContain('* src/foo.ts:25 [code]');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Format section output renders mixed code backlink roles]]
  it('renders mixed test and code backlinks with respective badges', () => {
    const section = makeMockSection('target#Target');
    const codeRefs: CodeBackRef[] = [
      {
        file: 'tests/unit.test.ts',
        line: 10,
        snippet: '// @lat: [[target#Target]]',
      },
      {
        file: 'src/service.ts',
        line: 50,
        snippet: '// @lat: [[target#Target]]',
      },
    ];
    const found = makeMockFound(section, [], codeRefs);
    const output = stripAnsi(formatSectionOutput(mockCtx, found));

    expect(output).toContain('* tests/unit.test.ts:10 [test]');
    expect(output).toContain('* src/service.ts:50 [code]');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Subtree descendant code references preserve snippet and line formatting]]
  it('preserves code backlink snippets when role badges are rendered', () => {
    const section = makeMockSection('guide#Guide');
    const codeRef: CodeBackRef = {
      file: 'src/app.ts',
      line: 8,
      snippet: '// @lat: [[guide#Guide#Child]]\nexport const run = true;',
    };
    const found = makeMockFound(section, [], [codeRef]);
    const output = stripAnsi(formatSectionOutput(mockCtx, found));

    expect(output).toContain('* src/app.ts:8 [code]');
    expect(output).toContain('| `// @lat: [[guide#Guide#Child]]`');
    expect(output).toContain('| `export const run = true;`');
  });
});

describe('end-to-end getSection and formatting with repository fixtures', () => {
  // @lat: [[fork-section-edges#Fork Section Edges#End to end section query populates backlink citation coordinates]]
  it('populates citation coordinates from wiki links and renders them in section output', async () => {
    const ctx = testCtx('short-ref');
    const result = await getSection(ctx, 'setup#Install');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    expect(result.incomingRefs.length).toBeGreaterThan(0);
    const incoming = result.incomingRefs[0];
    expect(incoming.citeFile).toBeDefined();
    expect(incoming.citeFile).toMatch(/links\.md$/);
    expect(incoming.citeLine).toBe(3);

    const output = stripAnsi(formatSectionOutput(ctx, result));
    expect(output).toContain('## Referenced by:');
    expect(output).toMatch(/\* \[\[lat\.md\/links#Links\]\] \(.*?links\.md:3\) — /);
  });

  // @lat: [[fork-section-edges#Fork Section Edges#End to end section query badges code backlink roles]]
  it('badges code references with [code] when querying fixture with source back-references', async () => {
    const ctx = testCtx('section-nested');
    const result = await getSection(ctx, 'guide#Guide');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    expect(result.codeRefs.length).toBe(2);
    const output = stripAnsi(formatSectionOutput(ctx, result));
    expect(output).toContain('## Referenced by code:');
    expect(output).toMatch(/\* [^:]*src\/example\.ts:1 \[code\]/);
    expect(output).toMatch(/\* [^:]*src\/example\.ts:4 \[code\]/);
  });
});

describe('core package subpath export and typography compliance', () => {
  // @lat: [[fork-section-edges#Fork Section Edges#Core package subpath export resolves section edges module]]
  it('exports classifyCodeRefRole and formatIncomingRefLocation from core subpath', () => {
    expect(typeof classifyCodeRefRole).toBe('function');
    expect(typeof formatIncomingRefLocation).toBe('function');
  });

  // @lat: [[fork-section-edges#Fork Section Edges#Backlink output labels and coordinates exclude em dashes]]
  it('produces backlink labels and coordinates containing zero em dashes and en dashes', () => {
    const loc = formatIncomingRefLocation('/repo', '/repo', 'lat.md/knowledge/cli.md', 42);
    expect(loc).not.toContain('\u2014');
    expect(loc).not.toContain('\u2013');

    const roleTest: CodeRefRole = classifyCodeRefRole('tests/foo.ts');
    const roleCode: CodeRefRole = classifyCodeRefRole('src/foo.ts');
    expect(roleTest).toBe('test');
    expect(roleCode).toBe('code');
    expect(`[${roleTest}]`).not.toMatch(/[\u2014\u2013]/);
    expect(`[${roleCode}]`).not.toMatch(/[\u2014\u2013]/);
  });
});
