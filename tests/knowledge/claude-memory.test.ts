import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { rmDirBestEffort } from '../util.js';
import { claudeMemoryStore } from '../../src/knowledge/claude-memory.js';

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

function slugify(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

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
    const projectPath = '/plain/project/root';
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
});
