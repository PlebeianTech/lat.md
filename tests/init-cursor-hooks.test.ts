import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  closeDb,
  ensureMeta,
  getLlmKey,
  getRepoEmbedding,
  getStoredModel,
  openDb,
  reindexCommand,
  selectMenu,
  setRepoEmbedding,
} = vi.hoisted(() => ({
  closeDb: vi.fn(async () => {}),
  ensureMeta: vi.fn(async () => {}),
  getLlmKey: vi.fn(),
  getRepoEmbedding: vi.fn(),
  getStoredModel: vi.fn(async () => null as string | null),
  openDb: vi.fn(() => ({})),
  reindexCommand: vi.fn(),
  selectMenu: vi.fn(),
  setRepoEmbedding: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  getLlmKey,
  getRepoEmbedding,
  setRepoEmbedding,
}));
vi.mock('../src/version.js', () => ({
  fetchLatestVersion: vi.fn(async () => null),
  getLocalVersion: vi.fn(() => 'test'),
}));
vi.mock('../src/cli/checklist-menu.js', () => ({
  checklistMenu: vi.fn(async () => []),
}));
vi.mock('../src/cli/select-menu.js', () => ({ selectMenu }));
vi.mock('../src/cli/reindex.js', () => ({ reindexCommand }));
vi.mock('../src/search/db.js', () => ({
  closeDb,
  ensureMeta,
  getStoredModel,
  openDb,
}));

import { initCmd } from '../src/cli/init.js';
import { checklistMenu } from '../src/cli/checklist-menu.js';

describe('lat init Cursor hooks', () => {
  let root: string;
  let stdinIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lat-init-cursor-'));
    mkdirSync(join(root, 'lat.md'), { recursive: true });
    stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    getLlmKey.mockReset();
    getRepoEmbedding.mockReset();
    getStoredModel.mockReset();
    getStoredModel.mockResolvedValue(null);
    selectMenu.mockReset();
    vi.mocked(checklistMenu).mockReset();
    vi.mocked(checklistMenu).mockResolvedValue(['cursor']);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[init#Cursor init registers a postToolUse hook]]
  it('registers a postToolUse hook for the comment reminder alongside stop', async () => {
    await initCmd(root);

    const hooksPath = join(root, '.cursor', 'hooks.json');
    expect(existsSync(hooksPath)).toBe(true);

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')) as {
      hooks: Record<string, { command: string }[]>;
    };

    expect(hooks.hooks.stop?.[0]?.command).toContain('hook cursor stop');
    // Deliberately postToolUse, not afterFileEdit: Cursor ignores the latter's
    // output, so a reminder sent from it could never reach the agent.
    expect(hooks.hooks.afterFileEdit).toBeUndefined();
    expect(hooks.hooks.postToolUse?.[0]?.command).toContain(
      'hook cursor postToolUse',
    );
  });
});
