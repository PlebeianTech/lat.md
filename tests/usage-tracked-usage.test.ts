import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { configureUsageLive, stopUsageLive } from '../src/fork/usage/live.js';
import { registerUsageCommand } from '../src/fork/usage/usage-cli.js';
import { startViewServer } from '../src/view/server.js';

const WARNING_FIX = 'git rm -r --cached .lat/usage';
const COMMENT =
  '# lat usage logs hold search queries and local paths: keep out of git';
const ENTRY = '.lat/usage/';

let root: string;
let stdout: string;
let stderr: string;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf-8' },
  ).trim();
}

/** A usage directory whose events file is staged, as a repository that commits it would have. */
function trackUsageFile(): void {
  git('init', '-q');
  mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
  const file = join(root, '.lat', 'usage', 'events-2026-11.jsonl');
  writeFileSync(file, '');
  git('add', '-f', '.lat/usage/events-2026-11.jsonl');
}

beforeEach(() => {
  vi.stubEnv('LAT_USAGE', '');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-tracked-')));
  mkdirSync(join(root, 'lat.md'));
  writeFileSync(join(root, 'lat.md', 'notes.md'), '# Notes\n\nText.\n');
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...parts) => {
    stdout += parts.join(' ') + '\n';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function lat(...args: string[]): Promise<string> {
  stdout = '';
  stderr = '';
  const program = new Command()
    .option('--dir <path>')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerUsageCommand(program, {
    bd: { refresh: async () => null },
    contributions: [],
    sources: [],
  });
  await program.parseAsync(['--dir', root, 'usage', ...args], {
    from: 'user',
  });
  return stdout;
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

// @lat: [[usage-tracked-usage#Usage Tracked Usage#lat usage warns when git tracks usage files]]
describe('lat usage warns when git tracks usage files', () => {
  it('prints the warning on stderr, once, and keeps stdout free of it', async () => {
    trackUsageFile();
    const text = await lat();
    expect(text).toContain('Commands:');
    expect(text).not.toContain(WARNING_FIX);
    expect(occurrences(stderr, WARNING_FIX)).toBe(1);
    expect(stderr).toContain('tracks');
  });

  it('leaves --json on stdout clean', async () => {
    trackUsageFile();
    const text = await lat('--json');
    expect(JSON.parse(text)).toHaveProperty('totals');
    expect(occurrences(stderr, WARNING_FIX)).toBe(1);
  });

  it('names no tracked file, so a planted file name cannot reach the terminal', async () => {
    trackUsageFile();
    await lat();
    expect(stderr).not.toContain('events-2026-11');
  });
});

// @lat: [[usage-tracked-usage#Usage Tracked Usage#No warning when nothing is tracked or git cannot say]]
describe('lat usage stays quiet when git has nothing to say', () => {
  it('prints nothing when no usage file is tracked', async () => {
    git('init', '-q');
    await lat('enable');
    const text = await lat();
    expect(text).toContain('Commands:');
    expect(stderr).toBe('');
  });

  it("prints nothing outside a git repository, not even git's own error", async () => {
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    const text = await lat();
    expect(text).toContain('Commands:');
    expect(stderr).toBe('');
  });

  it('prints nothing when git is not installed', async () => {
    trackUsageFile();
    vi.stubEnv('PATH', join(root, 'no-such-bin'));
    const text = await lat();
    expect(text).toContain('Commands:');
    expect(stderr).toBe('');
  });
});

// @lat: [[usage-tracked-usage#Usage Tracked Usage#lat ui warns once per project root]]
describe('lat ui warns once per project root', () => {
  it('prints the warning when the live state starts and not again on a restart', async () => {
    trackUsageFile();
    const clientDir = join(root, 'client');
    mkdirSync(clientDir);
    writeFileSync(join(clientDir, 'usage.html'), '<!doctype html><p>u</p>');
    configureUsageLive({
      sources: [],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 20,
      heartbeatMs: 20,
    });
    const server = await startViewServer(
      {
        projectRoot: root,
        latDir: join(root, 'lat.md'),
        mode: 'cli',
        styler: plainStyler,
      },
      { port: 0, watch: false, git: false, clientDir },
    );
    try {
      await (await fetch(server.url + 'api/usage')).json();
      expect(occurrences(stderr, WARNING_FIX)).toBe(1);
      await (await fetch(server.url + 'api/usage')).json();
      expect(occurrences(stderr, WARNING_FIX)).toBe(1);
      stopUsageLive(root);
      await (await fetch(server.url + 'api/usage')).json();
      expect(occurrences(stderr, WARNING_FIX)).toBe(1);
      expect(stdout).not.toContain(WARNING_FIX);
    } finally {
      stopUsageLive();
      configureUsageLive({});
      await server.close();
    }
  });
});

const ignoreFile = () => join(root, '.gitignore');

// @lat: [[usage-tracked-usage#Usage Tracked Usage#Enable adds the usage directory to .gitignore]]
describe('lat usage enable edits the project .gitignore', () => {
  it('creates the file with a short comment and the entry', async () => {
    await lat('enable');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(`${COMMENT}\n${ENTRY}\n`);
  });

  it('adds the entry once when enable runs twice', async () => {
    await lat('enable');
    await lat('enable');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(`${COMMENT}\n${ENTRY}\n`);
  });

  it('adds it on the already-enabled path', async () => {
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    expect(await lat('enable')).toContain('Already enabled');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(`${COMMENT}\n${ENTRY}\n`);
  });

  it('keeps existing lines and starts on a new line when the last one has no newline', async () => {
    writeFileSync(ignoreFile(), 'node_modules');
    await lat('enable');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(
      `node_modules\n${COMMENT}\n${ENTRY}\n`,
    );
  });

  it('keeps existing lines that end with a newline', async () => {
    writeFileSync(ignoreFile(), 'dist/\n');
    await lat('enable');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(
      `dist/\n${COMMENT}\n${ENTRY}\n`,
    );
  });

  it('does not count a commented-out or longer line as ignoring it', async () => {
    writeFileSync(ignoreFile(), '# .lat/usage/\n.lat/usage-old/\n');
    await lat('enable');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(
      `# .lat/usage/\n.lat/usage-old/\n${COMMENT}\n${ENTRY}\n`,
    );
  });
});

// @lat: [[usage-tracked-usage#Usage Tracked Usage#Enable skips an existing ignore line]]
describe('lat usage enable leaves a .gitignore that already ignores the directory', () => {
  for (const line of [
    '.lat/usage',
    '.lat/usage/',
    '/.lat/usage',
    '/.lat/usage/',
    '.lat/',
    '/.lat/',
  ]) {
    it(`changes nothing for ${line}`, async () => {
      const before = `dist/\n${line}\n`;
      writeFileSync(ignoreFile(), before);
      await lat('enable');
      expect(readFileSync(ignoreFile(), 'utf-8')).toBe(before);
    });
  }

  it('changes nothing for a line with Windows line endings', async () => {
    const before = 'dist/\r\n.lat/usage/\r\n';
    writeFileSync(ignoreFile(), before);
    await lat('enable');
    expect(readFileSync(ignoreFile(), 'utf-8')).toBe(before);
  });
});

// @lat: [[usage-tracked-usage#Usage Tracked Usage#Enable never writes through a symlinked .gitignore]]
describe('lat usage enable and a .gitignore it cannot edit', () => {
  for (const [name, exists] of [
    ['an existing target', true],
    ['a missing target', false],
  ] as const) {
    it(`skips a symlink to ${name} and prints one note`, async () => {
      const target = join(root, 'outside.txt');
      if (exists) writeFileSync(target, 'original\n');
      symlinkSync(target, ignoreFile());
      const text = await lat('enable');
      expect(lstatSync(ignoreFile()).isSymbolicLink()).toBe(true);
      expect(exists ? readFileSync(target, 'utf-8') : existsSync(target)).toBe(
        exists ? 'original\n' : false,
      );
      const notes = text.split('\n').filter((line) => line.includes('symlink'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(ignoreFile());
      expect(text).toContain('Usage tracking is on.');
      expect(process.exitCode ?? 0).toBe(0);
    });
  }

  it('prints a note instead of failing when .gitignore is a directory', async () => {
    mkdirSync(ignoreFile());
    const text = await lat('enable');
    expect(text).toContain(`Could not update ${ignoreFile()}`);
    expect(text).toContain('Usage tracking is on.');
    expect(existsSync(join(root, '.lat', 'usage'))).toBe(true);
  });
});
