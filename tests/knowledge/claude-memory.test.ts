import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { rmDirBestEffort } from '../util.js';
import {
  claudeMemoryStore,
  readFileCapped,
  slugify,
} from '../../src/knowledge/claude-memory.js';

// Wrap two node builtins so the memoization test can count real
// invocations. Both factories spread the actual module and replace only
// the one export under test with a `vi.fn` that still calls through to the
// real implementation — every other test in this file keeps unmocked
// behavior. The source under test spawns git via the async `execFile`, not
// `execFileSync`; `execFileSync` is still wrapped here because fixture setup
// in this file (creating the main checkout, adding worktrees) calls it
// directly.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    execFile: vi.fn(actual.execFile),
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const dirsToClean: string[] = [];
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;

afterEach(() => {
  for (const d of dirsToClean.splice(0)) rmDirBestEffort(d);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
});

/** Create `<home>/.claude/projects/<slug(projectPath)>/memory/` and point HOME there. */
function setUpMemoryDir(home: string, projectPath: string): string {
  const memoryDir = join(
    home,
    '.claude',
    'projects',
    slugify(projectPath),
    'memory',
  );
  mkdirSync(memoryDir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return memoryDir;
}

function writeMemo(
  memoryDir: string,
  filename: string,
  opts: { name?: string; description?: string; body: string },
): void {
  const front: string[] = [];
  if (opts.name !== undefined) front.push(`name: "${opts.name}"`);
  if (opts.description !== undefined)
    front.push(`description: "${opts.description}"`);
  const frontmatter = front.length ? `---\n${front.join('\n')}\n---\n` : '';
  writeFileSync(join(memoryDir, filename), frontmatter + opts.body);
}

describe('claudeMemoryStore', () => {
  it('returns [] when the memory directory does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const hits = await claudeMemoryStore.query({
      terms: ['anything'],
      projectRoot: '/no/such/project',
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('matches whole words only, case-insensitively, with frontmatter title/detail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    // A dot in the project root (e.g. a checkout named "lat.md") must
    // slugify like every other non-alphanumeric character. Regression test
    // for a `slugify` that special-cased "/" and left dots untouched.
    const projectPath = '/plain/project/root.app';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'a.md', {
      name: 'Memo A',
      description: 'about widgets',
      body: 'This mentions Widget assembly.',
    });
    // "widget" should NOT match "widgeting" (whole-word only).
    writeMemo(memoryDir, 'b.md', {
      body: 'A file about widgeting machines, no exact term.',
    });

    const hits = await claudeMemoryStore.query({
      terms: ['widget'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Memo A');
    expect(hits[0].detail).toBe('about widgets');
  });

  it('falls back to basename without .md when name: is absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = '/plain/project/root2';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'no-name.md', { body: 'Contains term foo.' });

    const hits = await claudeMemoryStore.query({
      terms: ['foo'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('no-name');
    expect(hits[0].detail).toBe('');
  });

  it('ranks by matched-term count, ties in first-seen (readdir) order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = '/plain/project/root3';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'a-first.md', { body: 'alpha only' });
    writeMemo(memoryDir, 'b-second.md', { body: 'alpha and beta both here' });
    writeMemo(memoryDir, 'c-third.md', { body: 'alpha appears again' });

    const hits = await claudeMemoryStore.query({
      terms: ['alpha', 'beta'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits[0].key.endsWith('b-second.md')).toBe(true);
    expect(hits[0].score).toBe(2);
    // a-first and c-third tie at score 1; first-seen (readdir/sorted) order
    // is alphabetical here, so a-first must precede c-third.
    const tieKeys = hits.slice(1).map((h) => h.key);
    expect(tieKeys[0].endsWith('a-first.md')).toBe(true);
    expect(tieKeys[1].endsWith('c-third.md')).toBe(true);
  });

  it('skips a symlinked .md file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const outside = mkdtempSync(join(tmpdir(), 'lat-cm-outside-'));
    dirsToClean.push(outside);
    const projectPath = '/plain/project/root4';
    const memoryDir = setUpMemoryDir(home, projectPath);

    const secretFile = join(outside, 'secret.md');
    writeFileSync(secretFile, 'contains term needle');
    try {
      symlinkSync(secretFile, join(memoryDir, 'link.md'));
    } catch {
      // Symlink creation can require elevated privileges on Windows; skip
      // the assertion body if we can't set up the fixture, rather than fail
      // the whole suite on unrelated platform permissions.
      return;
    }

    const hits = await claudeMemoryStore.query({
      terms: ['needle'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('handles a fake home directory whose path contains a space', async () => {
    // Regression test: the shell implementation this replaces used field
    // splitting on paths, so a memory directory under a path containing a
    // space (e.g. a project checkout under "My Projects/") had its path
    // truncated at the first word and every lookup on it silently failed.
    // Node's execFileSync/readdirSync take whole strings, so this class of
    // bug should be structurally impossible here — this test proves it.
    const home = mkdtempSync(join(tmpdir(), 'lat cm home '));
    dirsToClean.push(home);
    const projectPath = '/plain/project with space/root';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'spacey.md', {
      name: 'Spacey Memo',
      body: 'has the term spacetest inside',
    });

    const hits = await claudeMemoryStore.query({
      terms: ['spacetest'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Spacey Memo');
  });

  it('resolves the main checkout from a worktree via git rev-parse', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);

    // Resolve symlinks (e.g. macOS /tmp -> /private/tmp) up front: `git
    // rev-parse` reports the real path, and the store slugifies whatever
    // path it resolves to, so the test's expected memory dir must match.
    const mainCheckout = realpathSync(
      mkdtempSync(join(tmpdir(), 'lat-cm-main-')),
    );
    dirsToClean.push(mainCheckout);
    execFileSync('git', ['init', '-q'], { cwd: mainCheckout });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], {
      cwd: mainCheckout,
    });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: mainCheckout });
    writeFileSync(join(mainCheckout, 'f.txt'), 'x');
    execFileSync('git', ['add', 'f.txt'], { cwd: mainCheckout });
    execFileSync('git', ['commit', '-q', '-m', 'init'], {
      cwd: mainCheckout,
    });

    const worktreesParent = mkdtempSync(join(tmpdir(), 'lat-cm-wt-'));
    dirsToClean.push(worktreesParent);
    const worktreePath = join(worktreesParent, 'wt1');
    execFileSync(
      'git',
      ['worktree', 'add', '-q', worktreePath, '-b', 'wt1-branch'],
      { cwd: mainCheckout },
    );

    // Memory dir is keyed on the MAIN checkout's path, not the worktree's.
    const memoryDir = setUpMemoryDir(home, mainCheckout);
    writeMemo(memoryDir, 'wt.md', { body: 'worktree lookup works fine' });

    const hits = await claudeMemoryStore.query({
      terms: ['works'],
      projectRoot: worktreePath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);

    try {
      execFileSync('git', ['worktree', 'remove', '-f', worktreePath], {
        cwd: mainCheckout,
      });
    } catch {
      // best-effort cleanup
    }
  });

  it('falls back to projectRoot when git rev-parse fails (plain directory)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const plainDir = mkdtempSync(join(tmpdir(), 'lat-cm-plain-'));
    dirsToClean.push(plainDir);

    const memoryDir = setUpMemoryDir(home, plainDir);
    writeMemo(memoryDir, 'plain.md', { body: 'fallback path term here' });

    const hits = await claudeMemoryStore.query({
      terms: ['fallback'],
      projectRoot: plainDir,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
  });

  it('respects limit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = '/plain/project/root5';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'm1.md', { body: 'shared term' });
    writeMemo(memoryDir, 'm2.md', { body: 'shared term' });
    writeMemo(memoryDir, 'm3.md', { body: 'shared term' });

    const hits = await claudeMemoryStore.query({
      terms: ['shared'],
      projectRoot: projectPath,
      limit: 2,
    });

    expect(hits).toHaveLength(2);
  });

  // @lat: [[knowledge-store#claude-memory store: slugify and memoization#Matches a non-ASCII term at a word boundary]]
  it('matches a non-ASCII term at a word boundary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = '/plain/project/root6';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'cafe.md', {
      body: 'Meet me at a café here tomorrow.',
    });

    const hits = await claudeMemoryStore.query({
      terms: ['café'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
  });

  // @lat: [[knowledge-store#claude-memory store: slugify and memoization#Spawns git and reads each file only once per process]]
  it('spawns git and reads each file only once per process across repeated rank() calls', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = mkdtempSync(join(tmpdir(), 'lat-cm-memo-proj-'));
    dirsToClean.push(projectPath);
    const memoryDir = setUpMemoryDir(home, projectPath);
    writeMemo(memoryDir, 'a.md', { body: 'memoized term here' });

    const execSpy = vi.mocked(execFile);
    const { readFileSync: readSpyFn } = await import('node:fs');
    const readSpy = vi.mocked(readSpyFn);
    execSpy.mockClear();
    readSpy.mockClear();

    const q = { terms: ['memoized'], projectRoot: projectPath, limit: 10 };
    const first = await claudeMemoryStore.query(q);
    const gitCallsAfterFirst = execSpy.mock.calls.filter(
      (c) => c[0] === 'git',
    ).length;
    const readCallsAfterFirst = readSpy.mock.calls.length;

    const second = await claudeMemoryStore.query(q);
    const gitCallsAfterSecond = execSpy.mock.calls.filter(
      (c) => c[0] === 'git',
    ).length;
    const readCallsAfterSecond = readSpy.mock.calls.length;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(gitCallsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(gitCallsAfterSecond).toBe(gitCallsAfterFirst);
    expect(readCallsAfterSecond).toBe(readCallsAfterFirst);
  });
  it('reads name and description only from the frontmatter block, not the body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = '/plain/project/body-frontmatter';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeFileSync(
      join(memoryDir, 'a.md'),
      [
        '---',
        'title: "Not a name"',
        '---',
        '# Sprocket notes',
        '',
        'An example of what the frontmatter of a memory file looks like:',
        '',
        '```yaml',
        'name: "Injected title"',
        'description: "Injected detail from the body"',
        '```',
      ].join('\n'),
    );

    const hits = await claudeMemoryStore.query({
      terms: ['sprocket'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('a');
    expect(hits[0].detail).toBe('');
  });

  it('reads a frontmatter field that is not the first line of the block', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-cm-home-'));
    dirsToClean.push(home);
    const projectPath = '/plain/project/second-field';
    const memoryDir = setUpMemoryDir(home, projectPath);

    writeMemo(memoryDir, 'a.md', {
      name: 'Memo A',
      description: 'about grommets',
      body: 'Grommet notes.',
    });

    const hits = await claudeMemoryStore.query({
      terms: ['grommet'],
      projectRoot: projectPath,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Memo A');
    expect(hits[0].detail).toBe('about grommets');
  });

  it('does not sever a multi-byte character at the 64 KB read cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-cm-cap-'));
    dirsToClean.push(dir);
    const file = join(dir, 'big.md');

    // 'x' * 65535 puts the 3-byte U+4E2D at bytes 65536-65538, so the cap
    // falls one byte into it.
    writeFileSync(file, 'x'.repeat(65535) + '\u4e2d' + 'tail');

    const text = readFileCapped(file);
    expect(text).toBeDefined();
    expect(text).not.toContain('\uFFFD');
    expect(text).toBe('x'.repeat(65535));
  });
});
