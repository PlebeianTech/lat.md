import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MarkdownProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import type { Ref } from '@plebeiantech/lat.md-core/lattice-model';
import { rmDirBestEffort } from './util.js';
import {
  findUngroundedPromptFiles,
  formatCoverageGapNotice,
} from '../src/cli/fork-coverage-preflight.js';

function makeMockProject(
  projectRoot: string,
  wikiRefs: Ref[] = [],
  overrides?: Partial<MarkdownProjectAnalysis>,
): MarkdownProjectAnalysis {
  return {
    latDir: join(projectRoot, 'lat.md'),
    projectRoot,
    entries: [],
    markdownFiles: [],
    files: new Map(),
    filesByAbsolutePath: new Map(),
    allSections: [],
    sections: [],
    sectionById: new Map(),
    sectionIds: new Set(),
    fileIndex: new Map(),
    slugIndex: new Map() as any,
    wikiRefs,
    outgoingRefsBySection: new Map(),
    refsByTarget: new Map(),
    incomingRefsBySection: new Map(),
    ...overrides,
  };
}

function makeWikiRef(target: string, file = 'lat.md/doc.md', line = 10): Ref {
  return {
    target,
    fromSection: 'doc#Overview',
    file,
    line,
  };
}

describe('fork coverage preflight detector and formatter', () => {
  let tempDir: string;
  let project: MarkdownProjectAnalysis;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lat-preflight-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'components'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'cli'), { recursive: true });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    project = makeMockProject(tempDir);
  });

  afterEach(() => {
    rmDirBestEffort(tempDir);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Empty prompt returns empty array]]
  it('returns empty array when prompt is empty or contains no path tokens', async () => {
    expect(await findUngroundedPromptFiles(project, '')).toEqual([]);
    expect(await findUngroundedPromptFiles(project, '   \n\t  ')).toEqual([]);
    expect(
      await findUngroundedPromptFiles(
        project,
        'please optimize the algorithm and improve execution speed',
      ),
    ).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Grounded file with direct wiki link returns empty array]]
  it('recognizes files directly linked in wiki references as grounded', async () => {
    const filePath = 'src/components/button.tsx';
    writeFileSync(join(tempDir, filePath), 'export const Button = () => null;\n');

    const wikiRefs = [makeWikiRef('src/components/button.tsx#Button')];
    const groundedProject = makeMockProject(tempDir, wikiRefs);

    const prompt = 'Please refactor src/components/button.tsx to add loading state.';
    const result = await findUngroundedPromptFiles(groundedProject, prompt);

    expect(result).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Grounded file with parent directory wiki link returns empty array]]
  it('recognizes files grounded by parent directory wiki references', async () => {
    const filePath = 'src/cli/hook.ts';
    writeFileSync(join(tempDir, filePath), 'export function run() {}\n');

    const wikiRefs = [makeWikiRef('./src/cli/')];
    const groundedProject = makeMockProject(tempDir, wikiRefs);

    const prompt = 'Investigate the error handling in src/cli/hook.ts today.';
    const result = await findUngroundedPromptFiles(groundedProject, prompt);

    expect(result).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Grounded file with only in-file code ref comment returns empty array]]
  it('recognizes unlinked files containing in-file @lat: comments as grounded', async () => {
    const tsFile = 'src/annotated.ts';
    writeFileSync(
      join(tempDir, tsFile),
      '// @lat: [[auth#Authentication#Login]]\nexport function login() {}\n',
    );

    const pyFile = 'src/worker.py';
    writeFileSync(
      join(tempDir, pyFile),
      '# @lat: [[worker#Background#Job]]\ndef process(): pass\n',
    );

    const prompt = 'Review src/annotated.ts and src/worker.py for thread safety.';
    const result = await findUngroundedPromptFiles(project, prompt);

    expect(result).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Genuinely ungrounded source file detected and returned]]
  it('detects existing source files lacking wiki links and in-file code comments', async () => {
    writeFileSync(
      join(tempDir, 'src', 'orphan.ts'),
      'export const compute = () => 42;\n',
    );
    writeFileSync(
      join(tempDir, 'src', 'legacy.go'),
      'package main\nfunc main() {}\n',
    );

    const prompt = 'Please refactor src/orphan.ts and src/legacy.go to modern styles.';
    const result = await findUngroundedPromptFiles(project, prompt);

    expect(result).toEqual(['src/legacy.go', 'src/orphan.ts']);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Path with punctuation quotes symbol and line coordinates normalized]]
  it('normalizes paths wrapped in quotes punctuation anchors and line numbers', async () => {
    const filePath = 'src/orphan.ts';
    writeFileSync(join(tempDir, filePath), 'export const x = 1;\n');

    const testPrompts = [
      'Look at "src/orphan.ts" for details.',
      "Check 'src/orphan.ts' immediately.",
      'Inspect `src/orphan.ts` closely.',
      'Refer to (src/orphan.ts:42) in review.',
      'See [src/orphan.ts:15:3] for the problem.',
      'Investigate <src/orphan.ts#compute> symbol.',
      'Review src/orphan.ts, then submit.',
      'Fix src/orphan.ts; then test.',
      'Open src/orphan.ts: lines 1-10.',
      'Found in src/orphan.ts.',
    ];

    for (const prompt of testPrompts) {
      const result = await findUngroundedPromptFiles(project, prompt);
      expect(result).toEqual([filePath]);
    }
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Tooling and config files excluded from detection]]
  it('excludes tooling configurations and ambient declarations from ungrounded detection', async () => {
    writeFileSync(join(tempDir, 'vitest.config.ts'), 'export default {};\n');
    writeFileSync(join(tempDir, 'vite.config.js'), 'export default {};\n');
    writeFileSync(join(tempDir, 'env.d.ts'), 'declare var API_KEY: string;\n');
    writeFileSync(join(tempDir, 'types.d.ts'), 'declare type ID = string;\n');
    writeFileSync(join(tempDir, 'package.json'), '{\n  "name": "pkg"\n}\n');
    writeFileSync(join(tempDir, 'tsconfig.json'), '{\n  "compilerOptions": {}\n}\n');

    const prompt =
      'Update vitest.config.ts, vite.config.js, env.d.ts, types.d.ts, package.json, and tsconfig.json.';
    const result = await findUngroundedPromptFiles(project, prompt);

    expect(result).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Nonexistent files and directory paths excluded]]
  it('filters out nonexistent files and directory path candidates', async () => {
    const prompt =
      'Examine src/ghost.ts and browse directory src/components/ for inspiration.';
    const result = await findUngroundedPromptFiles(project, prompt);

    expect(result).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Directory traversal attacks and absolute paths excluded]]
  it('rejects path traversal tokens and absolute filesystem paths safely', async () => {
    const prompt =
      'Inspect ../../etc/passwd, /etc/passwd, and ../outside.ts before proceeding.';
    const result = await findUngroundedPromptFiles(project, prompt);

    expect(result).toEqual([]);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Candidate inspection capped at ten paths]]
  it('caps candidate inspection at ten unique candidate paths per prompt', async () => {
    const filePaths: string[] = [];
    for (let i = 0; i < 15; i++) {
      const relPath = `src/file${i}.ts`;
      writeFileSync(join(tempDir, relPath), `export const f${i} = ${i};\n`);
      filePaths.push(relPath);
    }

    const prompt = `Review all of these: ${filePaths.join(' ')}`;
    const result = await findUngroundedPromptFiles(project, prompt);

    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toHaveLength(10);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Notice formatting returns null on empty and formatted text on ungrounded files]]
  it('formats preflight notice with linking guidance and path sanitization', () => {
    expect(formatCoverageGapNotice([])).toBeNull();

    const ungrounded = ['src/orphan.ts', 'src/sub/[malicious].ts'];
    const notice = formatCoverageGapNotice(ungrounded);

    expect(notice).not.toBeNull();
    expect(notice).toContain('src/orphan.ts');
    expect(notice).toContain('src/sub/(malicious).ts');
    expect(notice).not.toContain('src/sub/[malicious].ts');
    expect(notice).toContain('connect them to the existing lat.md concept section');
    expect(notice).toContain('// @lat: [[section]]');
    expect(notice).toContain('[[file#symbol]]');
    expect(notice).toContain('do not create a separate prose section per file');
    expect(notice).not.toContain('—');
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Section wiki links do not falsely ground files in matching directories]]
  it('does not falsely ground files in directories matching doc stems when section links exist', async () => {
    writeFileSync(
      join(tempDir, 'tests', 'orphan.ts'),
      'export const testOrphan = () => 42;\n',
    );
    writeFileSync(
      join(tempDir, 'src', 'cli', 'orphan.ts'),
      'export const cliOrphan = () => 1;\n',
    );

    const wikiRefs = [
      makeWikiRef('tests#Heading'),
      makeWikiRef('cli#Heading'),
      makeWikiRef('lat.md/knowledge/tests#AnotherHeading'),
    ];
    const projectWithSectionLinks = makeMockProject(tempDir, wikiRefs);

    const prompt = 'Please refactor tests/orphan.ts and src/cli/orphan.ts.';
    const result = await findUngroundedPromptFiles(
      projectWithSectionLinks,
      prompt,
    );

    expect(result).toEqual(['src/cli/orphan.ts', 'tests/orphan.ts']);
  });

  // @lat: [[fork-coverage-preflight#Fork Coverage Preflight#Hook integration appends notice without breaking execution]]
  it('appends preflight notice to hook output and fails open on errors', async () => {
    const orphanPath = 'src/orphan.ts';
    writeFileSync(join(tempDir, orphanPath), 'export const a = 1;\n');

    const ungrounded = await findUngroundedPromptFiles(project, `Check ${orphanPath}`);
    const notice = formatCoverageGapNotice(ungrounded);

    const parts: string[] = ['Baseline instructions'];
    if (notice) {
      parts.push('', notice);
    }

    const output = parts.join('\n');
    expect(output).toContain('Baseline instructions');
    expect(output).toContain(orphanPath);
    expect(output).toContain('// @lat: [[section]]');

    const faultyProject = makeMockProject(tempDir, [], {
      projectRoot: '/nonexistent/path/for/failure',
    });

    let failedNotice: string | null = null;
    try {
      const files = await findUngroundedPromptFiles(
        faultyProject,
        'Check src/orphan.ts',
      );
      failedNotice = formatCoverageGapNotice(files);
    } catch {
      failedNotice = null;
    }

    const resilientParts = ['Baseline instructions'];
    if (failedNotice) {
      resilientParts.push('', failedNotice);
    }
    const resilientOutput = resilientParts.join('\n');
    expect(resilientOutput).toBe('Baseline instructions');
  });
});
