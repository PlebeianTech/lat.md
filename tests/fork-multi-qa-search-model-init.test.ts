import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getStoredModel } = vi.hoisted(() => ({
  getStoredModel: vi.fn(async () => null as string | null),
}));

vi.mock('../src/version.js', () => ({
  fetchLatestVersion: vi.fn(async () => null),
  getLocalVersion: vi.fn(() => 'test'),
}));
vi.mock('../src/cli/checklist-menu.js', () => ({
  checklistMenu: vi.fn(async () => []),
}));
vi.mock('@plebeiantech/lat.md-core/config', () => ({
  getLlmKey: vi.fn(() => undefined),
  getRepoEmbedding: vi.fn(() => undefined),
  setRepoEmbedding: vi.fn(),
}));
vi.mock('../src/search/db.js', () => ({
  closeDb: vi.fn(async () => {}),
  ensureMeta: vi.fn(async () => {}),
  getStoredModel,
  openDb: vi.fn(() => ({})),
}));
vi.mock('../src/cli/reindex.js', () => ({ reindexCommand: vi.fn() }));

import { INIT_VERSION } from '@plebeiantech/lat.md-core/init-version';
import { initCmd } from '../src/cli/init.js';

const huggingFaceUrlPrefix = 'https://huggingface.co/';

describe('lat init and the multi-qa download', () => {
  let root: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let stdinIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lat-multi-qa-init-'));
    mkdirSync(join(root, 'lat.md', '.cache'), { recursive: true });
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'model-cache'));
    vi.stubEnv('LAT_BUNDLED_EMBEDDING_MODEL', '');
    fetchMock = vi.fn(async () => new Response('not the pinned bytes'));
    vi.stubGlobal('fetch', fetchMock);
    stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    getStoredModel.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function modelRequests(): unknown[] {
    return fetchMock.mock.calls
      .map((call) => call[0])
      .filter((url) => String(url).startsWith(huggingFaceUrlPrefix));
  }

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A real lat init downloads for a fresh repo]]
  it('downloads the model for a repo with no index', async () => {
    getStoredModel.mockResolvedValue(null);

    await initCmd(root);

    expect(modelRequests().length).toBeGreaterThan(0);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#Re-running lat init fetches a missing model]]
  it('downloads the model again when a current repo lost its cache', async () => {
    writeFileSync(
      join(root, 'lat.md', '.cache', 'lat_init.json'),
      JSON.stringify({ init_version: INIT_VERSION }),
    );
    getStoredModel.mockResolvedValue(null);

    await initCmd(root);

    expect(modelRequests().length).toBeGreaterThan(0);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A real lat init skips the download for a MiniLM index]]
  it('does not download for an index that records MiniLM', async () => {
    writeFileSync(join(root, 'lat.md', '.cache', 'search.db'), '');
    getStoredModel.mockResolvedValue('local:minilm-l6-v2:384');

    await initCmd(root);

    expect(getStoredModel).toHaveBeenCalled();
    expect(modelRequests()).toEqual([]);
  });
});
