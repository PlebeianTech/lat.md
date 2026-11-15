import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const GUARD = join(REPO_ROOT, 'hooks', 'lat-guard.sh');

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

function makeProject(options: { nestedRepo: boolean }): string {
  const project = mkdtempSync(join(tmpdir(), 'lat-guard-nested-'));
  projects.push(project);
  const docs = join(project, 'lat.md');
  mkdirSync(join(docs, 'other'), { recursive: true });
  for (const name of ['a.md', 'c.md', 'd.md']) {
    writeFileSync(join(docs, 'other', name), `# ${name}\n\nBody.\n`);
  }
  if (options.nestedRepo) mkdirSync(join(docs, '.git'));
  return project;
}

function runGuard(project: string, args: string[]) {
  const env = { ...process.env };
  delete env.LAT_DISABLE;
  return spawnSync('sh', [GUARD, ...args], {
    env: {
      ...env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLAUDE_PROJECT_DIR: project,
    },
    cwd: project,
    encoding: 'utf-8',
  });
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe('lat-guard.sh with a nested repository', () => {
  // @lat: [[tests/fork-guard-nested-repo#Fork Guard Nested Repo#A nested repository named lat.md is not a docs directory]]
  it('writes nothing when lat.md is a git repository', () => {
    const project = makeProject({ nestedRepo: true });
    const before = listFiles(project);
    runGuard(project, ['check', 'index', '--fix']);
    expect(listFiles(project)).toEqual(before);
  });

  // @lat: [[tests/fork-guard-nested-repo#Fork Guard Nested Repo#A plain lat.md directory is still indexed]]
  it('still writes the missing index for a plain lat.md directory', () => {
    const project = makeProject({ nestedRepo: false });
    const before = listFiles(project);
    runGuard(project, ['check', 'index', '--fix']);
    expect(listFiles(project)).not.toEqual(before);
  });

  // @lat: [[tests/fork-guard-nested-repo#Fork Guard Nested Repo#A nested repository gets the init notice]]
  it('prints the init notice when lat.md is a git repository', () => {
    const project = makeProject({ nestedRepo: true });
    const result = runGuard(project, ['hook', 'claude', 'UserPromptSubmit']);
    expect(result.stdout).toContain('has no `lat.md/` directory');
  });
});
