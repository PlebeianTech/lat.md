import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MarkdownProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import type { Ref } from '@plebeiantech/lat.md-core/lattice-model';
import { CheckRunContext } from '@plebeiantech/lat.md-core/cli/check-context';
import type { CodeRef, ScanResult } from '@plebeiantech/lat.md-core/code-refs';
import { rmDirBestEffort } from './util.js';
import {
  parseUnifiedZeroDiff,
  findImpactedSectionsForDiff,
  findUnreviewedSectionsForDiff,
  type DiffLineRange,
} from '../src/cli/fork-stop-impact.js';
import {
  formatStopReason,
  getStopStatus,
  type StopStatus,
} from '../src/cli/hook.js';

function makeMockProject(
  projectRoot: string,
  wikiRefs: Ref[] = [],
  sectionIds: string[] = [],
  overrides?: Partial<MarkdownProjectAnalysis>,
): MarkdownProjectAnalysis {
  const sectionIdSet = new Set(sectionIds.map((id) => id.toLowerCase()));
  const sectionById = new Map<string, any>(
    sectionIds.map((id) => [
      id.toLowerCase(),
      { id, heading: id, file: id.split('#')[0] },
    ]),
  );
  const fileIndex = new Map<string, string[]>();
  for (const id of sectionIds) {
    const hashIdx = id.indexOf('#');
    const file = (hashIdx === -1 ? id : id.slice(0, hashIdx)).toLowerCase();
    const existing = fileIndex.get(file) ?? [];
    existing.push(file);
    fileIndex.set(file, existing);
  }
  return {
    latDir: join(projectRoot, 'lat.md'),
    projectRoot,
    entries: [],
    markdownFiles: [],
    files: new Map(),
    filesByAbsolutePath: new Map(),
    allSections: [],
    sections: [],
    sectionById,
    sectionIds: sectionIdSet,
    fileIndex,
    slugIndex: new Map() as any,
    wikiRefs,
    outgoingRefsBySection: new Map(),
    refsByTarget: new Map(),
    incomingRefsBySection: new Map(),
    ...overrides,
  };
}

function makeMockCheckRun(
  project: MarkdownProjectAnalysis,
  scanResult: ScanResult = { refs: [] },
): CheckRunContext {
  return {
    project: async () => project,
    codeRefs: async () => scanResult,
  } as unknown as CheckRunContext;
}

function makeCodeRef(file: string, line: number, target: string): CodeRef {
  return { file, line, target };
}

function makeWikiRef(
  target: string,
  fromSection: string,
  file = 'lat.md/doc.md',
  line = 1,
): Ref {
  return { target, fromSection, file, line };
}

describe('fork stop impact diff parser and section resolver', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lat-stop-impact-test-'));
  });

  afterEach(() => {
    rmDirBestEffort(tempDir);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Empty diff returns empty array]]
  it('returns empty array when diff output is empty or whitespace only', () => {
    expect(parseUnifiedZeroDiff('')).toEqual([]);
    expect(parseUnifiedZeroDiff('   \n\t  \n')).toEqual([]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Unified diff parser parses single hunk line range]]
  it('parses single hunk modification into inclusive line range', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1234567..89abcdef 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,5 +10,5 @@',
      '+const a = 1;',
    ].join('\n');

    expect(parseUnifiedZeroDiff(diff)).toEqual([
      { file: 'src/app.ts', startLine: 10, endLine: 14 },
    ]);

    const countOmitted = [
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -25 +25 @@',
    ].join('\n');
    expect(parseUnifiedZeroDiff(countOmitted)).toEqual([
      { file: 'src/index.ts', startLine: 25, endLine: 25 },
    ]);

    const noPrefixA = [
      'diff --git a/component.ts a/component.ts',
      '--- a/component.ts',
      '+++ a/component.ts',
      '@@ -10,3 +10,3 @@',
      '+const a = 1;',
    ].join('\n');
    expect(parseUnifiedZeroDiff(noPrefixA)).toEqual([
      { file: 'a/component.ts', startLine: 10, endLine: 12 },
    ]);

    const noPrefixB = [
      'diff --git b/service.ts b/service.ts',
      '--- b/service.ts',
      '+++ b/service.ts',
      '@@ -5,2 +5,2 @@',
      '+const b = 2;',
    ].join('\n');
    expect(parseUnifiedZeroDiff(noPrefixB)).toEqual([
      { file: 'b/service.ts', startLine: 5, endLine: 6 },
    ]);

    const renamedFile = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 80%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -12,2 +12,3 @@',
    ].join('\n');
    expect(parseUnifiedZeroDiff(renamedFile)).toEqual([
      { file: 'src/new.ts', startLine: 12, endLine: 14 },
    ]);

    const addedFile = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,10 @@',
    ].join('\n');
    expect(parseUnifiedZeroDiff(addedFile)).toEqual([
      { file: 'src/new.ts', startLine: 1, endLine: 10 },
    ]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Unified diff parser parses multiple hunks across multiple files]]
  it('parses multiple files and multiple hunks in order', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,2 +5,4 @@',
      '@@ -20,1 +22,1 @@',
      '--- a/src/b.py',
      '+++ b/src/b.py',
      '@@ -50,3 +50,3 @@',
    ].join('\n');

    expect(parseUnifiedZeroDiff(diff)).toEqual([
      { file: 'src/a.ts', startLine: 5, endLine: 8 },
      { file: 'src/a.ts', startLine: 22, endLine: 22 },
      { file: 'src/b.py', startLine: 50, endLine: 52 },
    ]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Unified diff parser handles zero count deletion hunks]]
  it('preserves single-line deletion location when newCount is zero', () => {
    const diff = [
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -40,10 +40,0 @@',
      '-removed line',
    ].join('\n');

    expect(parseUnifiedZeroDiff(diff)).toEqual([
      { file: 'src/index.ts', startLine: 40, endLine: 40 },
    ]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Non source files and deleted files are ignored]]
  it('ignores deleted files and non-source files such as markdown json and binary diffs', () => {
    const diff = [
      '--- a/src/legacy.ts',
      '+++ /dev/null',
      '@@ -1,50 +0,0 @@',
      '--- a/lat.md/doc.md',
      '+++ b/lat.md/doc.md',
      '@@ -1,5 +1,5 @@',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -10,2 +10,2 @@',
      'diff --git a/bin/artifact b/bin/artifact',
      'Binary files a/bin/artifact and b/bin/artifact differ',
    ].join('\n');

    expect(parseUnifiedZeroDiff(diff)).toEqual([]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Exact line match to code reference resolves canonical section]]
  it('resolves code reference directly overlapping hunk range', async () => {
    const section = 'cli#CLI#service#Exact';
    const project = makeMockProject(tempDir, [], [section]);
    const codeRefs = {
      refs: [makeCodeRef('src/service.ts', 22, section)],
    };
    const run = makeMockCheckRun(project, codeRefs);

    const diffRanges: DiffLineRange[] = [
      { file: 'src/service.ts', startLine: 20, endLine: 25 },
    ];

    const impacted = await findImpactedSectionsForDiff(
      tempDir,
      run,
      diffRanges,
    );
    expect(impacted).toEqual([section]);

    const colonSection = 'cli#Step 1: Setup';
    const colonProject = makeMockProject(tempDir, [], [colonSection]);
    const colonCodeRefs = {
      refs: [makeCodeRef('src/service.ts', 22, colonSection)],
    };
    const colonRun = makeMockCheckRun(colonProject, colonCodeRefs);
    const colonImpacted = await findImpactedSectionsForDiff(
      tempDir,
      colonRun,
      diffRanges,
    );
    expect(colonImpacted).toEqual([colonSection]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Code reference within fifteen lines resolves canonical section]]
  it('resolves code reference falling within fifteen lines of hunk', async () => {
    const section = 'cli#CLI#service#Proximity';
    const project = makeMockProject(tempDir, [], [section]);
    const codeRefs = {
      refs: [makeCodeRef('src/service.ts', 20, section)],
    };
    const run = makeMockCheckRun(project, codeRefs);

    const diffRanges: DiffLineRange[] = [
      { file: 'src/service.ts', startLine: 30, endLine: 35 },
    ];

    const impacted = await findImpactedSectionsForDiff(
      tempDir,
      run,
      diffRanges,
    );
    expect(impacted).toEqual([section]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Nearest preceding code reference resolves when outside window]]
  it('resolves nearest preceding code reference when none falls within fifteen lines', async () => {
    const sectionPreceding = 'cli#CLI#service#Preceding';
    const sectionLater = 'cli#CLI#service#Later';
    const project = makeMockProject(
      tempDir,
      [],
      [sectionPreceding, sectionLater],
    );
    const codeRefs = {
      refs: [
        makeCodeRef('src/service.ts', 20, sectionPreceding),
        makeCodeRef('src/service.ts', 120, sectionLater),
      ],
    };
    const run = makeMockCheckRun(project, codeRefs);

    const diffRanges: DiffLineRange[] = [
      { file: 'src/service.ts', startLine: 80, endLine: 85 },
    ];

    const impacted = await findImpactedSectionsForDiff(
      tempDir,
      run,
      diffRanges,
    );
    expect(impacted).toEqual([sectionPreceding]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Wiki reference targeting modified file resolves source section]]
  it('resolves governing markdown section from wiki link to modified file', async () => {
    const section = 'math#Calculator#Overview';
    const wikiRefs = [makeWikiRef('src/calc.ts#add', section)];
    const project = makeMockProject(tempDir, wikiRefs, [section]);
    const run = makeMockCheckRun(project);

    const diffRanges: DiffLineRange[] = [
      { file: 'src/calc.ts', startLine: 10, endLine: 12 },
    ];

    const impacted = await findImpactedSectionsForDiff(
      tempDir,
      run,
      diffRanges,
    );
    expect(impacted).toEqual([section]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Section results are deduplicated sorted and capped at ten]]
  it('merges deduplicates sorts and caps sections at ten items', async () => {
    const sectionNames = Array.from(
      { length: 15 },
      (_, i) => `doc#Section#Item${String(i).padStart(2, '0')}`,
    );
    const wikiRefs = sectionNames.map((name) =>
      makeWikiRef('src/big.ts', name),
    );
    const project = makeMockProject(tempDir, wikiRefs, sectionNames);
    const codeRefs = {
      refs: [makeCodeRef('src/big.ts', 15, sectionNames[0])],
    };
    const run = makeMockCheckRun(project, codeRefs);

    const diffRanges: DiffLineRange[] = [
      { file: 'src/big.ts', startLine: 1, endLine: 50 },
    ];

    const impacted = await findImpactedSectionsForDiff(
      tempDir,
      run,
      diffRanges,
    );
    expect(impacted).toHaveLength(10);
    expect(impacted).toEqual(sectionNames.slice(0, 10));
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Untrusted section identifiers are sanitized]]
  it('sanitizes untrusted characters in section identifiers', async () => {
    const rawSection = 'doc#Section#Unsafe[Bracket]';
    const cleanSection = 'doc#Section#Unsafe(Bracket)';
    const project = makeMockProject(tempDir, [], [rawSection]);
    const codeRefs = {
      refs: [makeCodeRef('src/safe.ts', 12, rawSection)],
    };
    const run = makeMockCheckRun(project, codeRefs);

    const diffRanges: DiffLineRange[] = [
      { file: 'src/safe.ts', startLine: 10, endLine: 15 },
    ];

    const impacted = await findImpactedSectionsForDiff(
      tempDir,
      run,
      diffRanges,
    );
    expect(impacted).toEqual([cleanSection]);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Git execution failure fails open with empty array]]
  it('degrades gracefully to empty array when git execution fails or outside git', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'lat-non-git-'));
    try {
      const project = makeMockProject(nonGitDir);
      const run = makeMockCheckRun(project);

      const impacted = await findImpactedSectionsForDiff(nonGitDir, run);
      expect(impacted).toEqual([]);
    } finally {
      rmDirBestEffort(nonGitDir);
    }
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Stop hook formats impacted sections receipt when sync needed]]
  it('formats impacted sections receipt when sync needed and matches exist', () => {
    const statusWithImpact: StopStatus = {
      checkFailed: false,
      totalErrors: 0,
      needsSync: true,
      codeLines: 100,
      latMdLines: 0,
      impactedSections: ['cli#CLI#hook#Stop', 'tests/hook#Stop Hook'],
    };

    const formatted = formatStopReason(statusWithImpact);
    expect(formatted).not.toBeNull();
    expect(formatted).toContain(
      'Sections linked to modified code: [[cli#CLI#hook#Stop]], [[tests/hook#Stop Hook]]',
    );

    const statusWithoutImpact: StopStatus = {
      checkFailed: false,
      totalErrors: 0,
      needsSync: true,
      codeLines: 100,
      latMdLines: 0,
      impactedSections: [],
    };
    const formattedWithout = formatStopReason(statusWithoutImpact);
    expect(formattedWithout).not.toBeNull();
    expect(formattedWithout).not.toContain('Sections linked to modified code');

    const statusNoSync: StopStatus = {
      checkFailed: false,
      totalErrors: 0,
      needsSync: false,
      codeLines: 2,
      latMdLines: 0,
      impactedSections: ['cli#CLI#hook#Stop'],
    };
    expect(formatStopReason(statusNoSync)).toBeNull();
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Lat Tests',
  GIT_AUTHOR_EMAIL: 'lat@example.invalid',
  GIT_COMMITTER_NAME: 'Lat Tests',
  GIT_COMMITTER_EMAIL: 'lat@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function docWithSections(names: string[]): string {
  return [
    '# Doc',
    '',
    'Doc overview.',
    '',
    ...names.flatMap((name) => [`## ${name}`, '', `About ${name}.`, '']),
  ].join('\n');
}

function codeLinkedTo(sectionRefs: string[], body: string): string {
  return (
    sectionRefs.map((ref) => `// @lat: [[${ref}]]\n`).join('') +
    `${body}\n`.repeat(200)
  );
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function rewriteParagraph(repo: string, docPath: string, name: string): void {
  const path = join(repo, docPath);
  const content = readFileSync(path, 'utf-8');
  writeFileSync(
    path,
    content.replace(`About ${name}.`, `About ${name}, rewritten.`),
  );
}

describe('fork stop impact reviewed sections', () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmDirBestEffort(repo);
  });

  /**
   * Commit `lat.md/doc.md` holding `sectionNames` and `src/app.ts` whose
   * first lines link to `linkedNames`, then change 200 code lines.
   */
  function makeRepo(sectionNames: string[], linkedNames: string[]): string {
    const repo = mkdtempSync(join(tmpdir(), 'lat-stop-reviewed-'));
    repos.push(repo);
    const refs = linkedNames.map((name) => `doc#Doc#${name}`);
    writeFiles(repo, {
      'lat.md/.gitignore': '.cache/\n',
      'lat.md/lat.md': '# Project\n\n- [[doc]] — Doc\n',
      'lat.md/doc.md': docWithSections(sectionNames),
      'src/app.ts': codeLinkedTo(refs, 'const before = 0;'),
    });
    git(repo, 'init', '--quiet');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'initial');
    writeFiles(repo, { 'src/app.ts': codeLinkedTo(refs, 'const after = 1;') });
    return repo;
  }

  function reviewStatus(repo: string) {
    const latDir = join(repo, 'lat.md');
    return findUnreviewedSectionsForDiff(
      repo,
      new CheckRunContext(latDir, repo),
    );
  }

  // @lat: [[fork-stop-impact#Fork Stop Impact#Untouched linked section is not reviewed]]
  it('lists a linked section that was not edited', async () => {
    const repo = makeRepo(['Transport'], ['Transport']);

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: ['lat.md/doc#Doc#Transport'],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Rewritten linked section clears the reminder]]
  it('counts a rewritten linked section as reviewed and clears the reminder', async () => {
    const repo = makeRepo(['Transport'], ['Transport']);
    rewriteParagraph(repo, 'lat.md/doc.md', 'Transport');

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: [],
      callerSections: [],
    });

    const freshRepo = makeRepo(['Transport'], ['Transport']);
    rewriteParagraph(freshRepo, 'lat.md/doc.md', 'Transport');
    const status = await getStopStatus(join(freshRepo, 'lat.md'));
    expect(status.latMdLines).toBe(2);
    expect(status.needsSync).toBe(false);
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Only unreviewed linked sections are listed]]
  it('lists only the linked sections that were not edited', async () => {
    const repo = makeRepo(['Storage', 'Transport'], ['Storage', 'Transport']);
    rewriteParagraph(repo, 'lat.md/doc.md', 'Transport');

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 2,
      unreviewedSections: ['lat.md/doc#Doc#Storage'],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Ten section cap applies after reviewed sections are removed]]
  it('applies the ten section cap after removing reviewed sections', async () => {
    const names = Array.from(
      { length: 12 },
      (_, i) => `Item${String(i + 1).padStart(2, '0')}`,
    );
    const repo = makeRepo(names, names);
    for (const name of names.slice(0, 10)) {
      rewriteParagraph(repo, 'lat.md/doc.md', name);
    }

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 12,
      unreviewedSections: ['lat.md/doc#Doc#Item11', 'lat.md/doc#Doc#Item12'],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Section in an untracked doc file counts as reviewed]]
  it('counts a linked section in an untracked lat.md file as reviewed', async () => {
    const repo = makeRepo(['Transport'], []);
    const refs = ['fresh#Fresh#Topic'];
    writeFiles(repo, {
      'src/app.ts': codeLinkedTo(refs, 'const before = 0;'),
    });
    git(repo, 'commit', '--quiet', '-am', 'link to a new doc');
    writeFiles(repo, {
      'lat.md/fresh.md': '# Fresh\n\n## Topic\n\nAbout Topic.\n',
      'src/app.ts': codeLinkedTo(refs, 'const after = 1;'),
    });

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: [],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Large non-code diff still counts an edited section]]
  it('counts an edited linked section as reviewed beside a large non-code diff', async () => {
    const repo = makeRepo(['Transport'], ['Transport']);
    const line = (n: number, value: string) =>
      `  "package-${n}": "${value}-${'x'.repeat(40)}",\n`;
    const lockfile = (value: string) =>
      Array.from({ length: 30000 }, (_, n) => line(n, value)).join('');
    writeFiles(repo, { 'data.json': lockfile('old') });
    git(repo, 'add', 'data.json');
    git(repo, 'commit', '--quiet', '-m', 'add a large data file');
    writeFiles(repo, { 'data.json': lockfile('new') });
    rewriteParagraph(repo, 'lat.md/doc.md', 'Transport');

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: [],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Section in a non-ASCII file name counts as reviewed]]
  it('counts an edited linked section in a non-ASCII doc file name as reviewed', async () => {
    const repo = makeRepo(['Transport'], []);
    const refs = ['café#Café#Topic'];
    writeFiles(repo, {
      'lat.md/café.md':
        '# Café\n\nCafé overview.\n\n## Topic\n\nAbout Topic.\n',
      'src/app.ts': codeLinkedTo(refs, 'const before = 0;'),
    });
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'link to a non-ASCII doc');
    writeFiles(repo, { 'src/app.ts': codeLinkedTo(refs, 'const after = 1;') });
    rewriteParagraph(repo, 'lat.md/café.md', 'Topic');

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: [],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Colored diff config still counts an edited section]]
  it('counts an edited linked section as reviewed with color.ui set to always', async () => {
    const repo = makeRepo(['Transport'], ['Transport']);
    git(repo, 'config', 'color.ui', 'always');
    rewriteParagraph(repo, 'lat.md/doc.md', 'Transport');

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: [],
      callerSections: [],
    });
  });

  // @lat: [[fork-stop-impact#Fork Stop Impact#Code change without linked sections keeps the ratio rule]]
  it('keeps the line ratio rule when no section is linked', async () => {
    const repo = makeRepo(['Transport'], []);
    // Commit what lat check needs, away from the lines the diff changes: a
    // leading paragraph in the root index, and one ref in a file the diff
    // does not touch. lat check passes and the diff still links no section.
    writeFiles(repo, {
      'lat.md/lat.md': '# Project\n\nThe project.\n\n- [[doc]] — Doc\n',
      'src/entry.ts': '// @lat: [[doc#Doc#Transport]]\n',
    });
    git(repo, 'add', 'lat.md/lat.md', 'src/entry.ts');
    git(repo, 'commit', '--quiet', '-m', 'pass lat check');
    rewriteParagraph(repo, 'lat.md/doc.md', 'Transport');

    const status = await getStopStatus(join(repo, 'lat.md'));
    expect(status.checkFailed).toBe(false);
    expect(status.codeLines).toBe(400);
    expect(status.latMdLines).toBe(2);
    expect(status.needsSync).toBe(true);
    expect(status.impactedSections).toEqual([]);
  });
});
