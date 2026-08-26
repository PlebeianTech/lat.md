import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, symlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @lat: [[check-index#Generated index write guard]]

const cliPath = join(import.meta.dirname, '..', 'dist', 'src', 'cli', 'index.js');
const fixtureDir = join(import.meta.dirname, 'cases', 'index-guard-symlink');

const tmpDirs: string[] = [];

function makeTmpCase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-index-guard-'));
  cpSync(fixtureDir, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function runCheckFix(cwd: string) {
  return spawnSync(process.execPath, [cliPath, 'check', '--fix'], {
    cwd,
    encoding: 'utf-8',
  });
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('generated index write guard', () => {
  // @lat: [[check-index#Generated index write guard#Symlink at the index path]]
  it('refuses to write through a symlink at the index path, leaving the target untouched', () => {
    const dir = makeTmpCase();
    const victimPath = join(dir, 'victim.txt');
    const sentinel = 'SENTINEL - must not be overwritten\n';
    writeFileSync(victimPath, sentinel, 'utf-8');

    const indexPath = join(dir, 'lat.md', 'guide', 'guide.md');
    symlinkSync(victimPath, indexPath);

    const result = runCheckFix(dir);

    expect(readFileSync(victimPath, 'utf-8')).toBe(sentinel);

    const output = (result.stdout ?? '') + (result.stderr ?? '');
    expect(output.toLowerCase()).toContain('symlink');
  });

  // @lat: [[check-index#Generated index write guard#Symlink pre-planted at the temp path]]
  it('refuses to write when a symlink is pre-planted at the temp write path', () => {
    const dir = makeTmpCase();
    const victimPath = join(dir, 'victim.txt');
    const sentinel = 'SENTINEL - must not be overwritten\n';
    writeFileSync(victimPath, sentinel, 'utf-8');

    const tempCandidate = join(dir, 'lat.md', 'guide', 'guide.md.tmp');
    symlinkSync(victimPath, tempCandidate);

    const result = runCheckFix(dir);

    expect(readFileSync(victimPath, 'utf-8')).toBe(sentinel);
    expect(result.status).toBeDefined();
  });

  // @lat: [[check-index#Generated index write guard#Normal non-symlink case]]
  it('still writes the generated index correctly when there is no symlink involved', () => {
    const dir = makeTmpCase();
    const indexPath = join(dir, 'lat.md', 'guide', 'guide.md');
    expect(existsSync(indexPath)).toBe(false);

    const result = runCheckFix(dir);

    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('Topic');
    expect(result.status).toBe(0);
  });
});
