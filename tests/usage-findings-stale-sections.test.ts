import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findingDetectors } from '../src/fork/usage/findings.js';
import {
  createStaleHotSectionDetector,
  staleHotSectionDetector,
} from '../src/fork/usage/findings-stale-sections.js';
import type {
  SectionRow,
  UsageSummary,
} from '../src/fork/usage/aggregate-types.js';

const HOUR = 3600;
const BASE = Date.parse('2026-01-01T00:00:00Z') / 1000;

let root: string;

function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
}

function commit(files: Record<string, string>, hours: number) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git('add', '-A');
  const date = `${BASE + hours * HOUR} +0000`;
  execFileSync('git', ['-C', root, 'commit', '-m', `at ${hours}`], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

const doc = (...titles: string[]) =>
  `# Doc\n\n${titles.map((t) => `## ${t}\n\nBody of ${t}.\n`).join('\n')}`;
const ref = (title: string) => `// @lat: [[doc#Doc#${title}]]\n`;

function row(title: string, reads: number): SectionRow {
  return { key: `doc#Doc#${title}`, reads } as unknown as SectionRow;
}
const summaryOf = (sections: SectionRow[]) =>
  ({
    sections,
    days: ['2026-01-01'],
    extensions: {},
  }) as unknown as UsageSummary;

function gitLogCalls(calls: string[][]) {
  return calls.filter((args) => args.includes('log')).length;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lat-stale-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('stale-hot-section detector', () => {
  it('is registered with the findings engine', () => {
    expect(findingDetectors).toContain(staleHotSectionDetector);
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A referenced file newer than its section is stale]]
  it('flags a referenced file newer than its section', async () => {
    commit({ 'lat.md/doc.md': doc('Hot'), 'src/a.ts': ref('Hot') }, 0);
    commit({ 'src/a.ts': ref('Hot') + '// changed\n' }, 5);
    const detector = createStaleHotSectionDetector();
    await detector.prepare!({ root });
    const found = detector.detect({
      summary: summaryOf([row('Hot', 3)]),
      records: [],
    });
    expect(found.map((f) => [f.kind, f.subject])).toEqual([
      ['stale-hot-section', 'doc#Doc#Hot'],
    ]);
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A section that links a source file goes stale with it]]
  it('flags a section whose wikilink names a newer source file', async () => {
    const linking =
      '# Doc\n\n## Hot\n\nSee [[src/x.ts#fn]] and [[src/x.ts]].\n';
    commit(
      { 'lat.md/doc.md': linking, 'src/x.ts': 'export const fn = 1;\n' },
      0,
    );
    commit({ 'src/x.ts': 'export const fn = 2;\n' }, 5);
    const calls: string[][] = [];
    const detector = createStaleHotSectionDetector(async (cwd, args) => {
      calls.push(args);
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
    });
    await detector.prepare!({ root });
    const found = detector.detect({
      summary: summaryOf([row('Hot', 3)]),
      records: [],
    });
    expect(found.map((f) => f.subject)).toEqual(['doc#Doc#Hot']);
    expect(calls.flat().filter((arg) => arg.includes('#'))).toEqual([]);
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A project in a repository subdirectory is checked]]
  it('flags a stale section when the project root is a subdirectory', async () => {
    commit(
      { 'proj/lat.md/doc.md': doc('Hot'), 'proj/src/x.ts': ref('Hot') },
      0,
    );
    commit({ 'proj/src/x.ts': ref('Hot') + '// changed\n' }, 5);
    const detector = createStaleHotSectionDetector();
    await detector.prepare!({ root: join(root, 'proj') });
    const found = detector.detect({
      summary: summaryOf([row('Hot', 3)]),
      records: [],
    });
    expect(found.map((f) => f.subject)).toEqual(['doc#Doc#Hot']);
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A referenced file older than its section is not stale]]
  it('does not flag a referenced file older than its section', async () => {
    commit({ 'src/a.ts': ref('Hot'), 'lat.md/doc.md': doc('Hot') }, 0);
    commit({ 'lat.md/doc.md': doc('Hot') + '\nedited\n' }, 5);
    const detector = createStaleHotSectionDetector();
    await detector.prepare!({ root });
    expect(
      detector.detect({ summary: summaryOf([row('Hot', 3)]), records: [] }),
    ).toEqual([]);
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A section outside the top 20 is ignored]]
  it('ignores a stale section outside the top 20 by reads', async () => {
    const titles = Array.from({ length: 21 }, (_, i) => `S${i}`);
    commit(
      {
        'lat.md/doc.md': doc(...titles),
        'src/a.ts': titles.map(ref).join(''),
      },
      0,
    );
    commit({ 'src/a.ts': titles.map(ref).join('') + '// changed\n' }, 5);
    const detector = createStaleHotSectionDetector();
    await detector.prepare!({ root });
    // S0 has the fewest reads, so it is ranked 21st.
    const sections = titles.map((t, i) => row(t, i + 1));
    const subjects = detector
      .detect({ summary: summaryOf(sections), records: [] })
      .map((f) => f.subject);
    expect(subjects).toHaveLength(20);
    expect(subjects).not.toContain('doc#Doc#S0');
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A second call at the same git head does not run git again]]
  it('does not run git log again at the same git head', async () => {
    commit({ 'lat.md/doc.md': doc('Hot'), 'src/a.ts': ref('Hot') }, 0);
    const calls: string[][] = [];
    const detector = createStaleHotSectionDetector(async (cwd, args) => {
      calls.push(args);
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
    });
    await detector.prepare!({ root });
    const first = gitLogCalls(calls);
    expect(first).toBeGreaterThan(0);
    await detector.prepare!({ root });
    expect(gitLogCalls(calls)).toBe(first);
    commit({ 'src/a.ts': ref('Hot') + '// changed\n' }, 5);
    await detector.prepare!({ root });
    expect(gitLogCalls(calls)).toBeGreaterThan(first);
  });

  // @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A missing repository fails prepare]]
  it('throws from prepare when the root is not a git repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'lat-stale-bare-'));
    try {
      await expect(
        createStaleHotSectionDetector().prepare!({ root: bare }),
      ).rejects.toThrow();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
