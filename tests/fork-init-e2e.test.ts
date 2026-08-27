import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The one path the unit tests cannot reach: `initCmd` end to end, with an
 * agent selected, asserting that the fork's block and scaffold land in the
 * files upstream's own setup steps just wrote.
 */

const { checklistMenu, selectMenu } = vi.hoisted(() => ({
  checklistMenu: vi.fn(async () => ['claude']),
  selectMenu: vi.fn(async () => 'global'),
}));

vi.mock('../src/cli/checklist-menu.js', () => ({ checklistMenu }));
vi.mock('../src/cli/select-menu.js', () => ({ selectMenu }));
vi.mock('../src/version.js', () => ({
  fetchLatestVersion: vi.fn(async () => null),
  getLocalVersion: vi.fn(() => 'test'),
}));
vi.mock('../src/config.js', () => ({
  getLlmKey: vi.fn(() => null),
  getRepoEmbedding: vi.fn(() => undefined),
  setRepoEmbedding: vi.fn(),
}));
vi.mock('../src/search/db.js', () => ({
  closeDb: vi.fn(async () => {}),
  ensureMeta: vi.fn(async () => {}),
  getStoredModel: vi.fn(async () => null),
  openDb: vi.fn(() => ({})),
}));
vi.mock('../src/cli/reindex.js', () => ({ reindexCommand: vi.fn() }));

import { initCmd } from '../src/cli/init.js';

describe('lat init installs the fork conventions', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lat-fork-e2e-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[tests/fork-instructions#Fork Instructions#A real init lands the block and the scaffold together]]
  it('writes the block, the skill and the mode directories in one run', async () => {
    await initCmd(root);

    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('%% lat:begin %%');
    expect(claudeMd).toContain('%% lat-fork:begin %%');
    expect(claudeMd).toContain('not a language allowlist');

    expect(
      existsSync(
        join(root, '.claude', 'skills', 'lat-md-conventions', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude', 'skills', 'lat-md', 'SKILL.md')),
    ).toBe(true);

    const rootIndex = readFileSync(join(root, 'lat.md', 'lat.md'), 'utf-8');
    expect(rootIndex).toContain('require-mode: true');
    for (const dir of ['tutorials', 'how-to', 'reference', 'explanation']) {
      expect(existsSync(join(root, 'lat.md', dir, `${dir}.md`))).toBe(true);
    }
  });
});
