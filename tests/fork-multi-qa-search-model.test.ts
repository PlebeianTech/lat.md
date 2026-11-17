import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

const miniLmEmbedderName = 'local:minilm-l6-v2';
const miniLmStoredModel = 'local:minilm-l6-v2:384';
const multiQaEmbedderName = 'local:multi-qa-minilm-l6-cos-v1';
const multiQaStoredModel = 'local:multi-qa-minilm-l6-cos-v1:384';

const platformCacheFolders: Partial<Record<NodeJS.Platform, string>> = {
  darwin: join(homedir(), 'Library', 'Caches'),
  linux: join(homedir(), '.cache'),
};

const fakeFileContents: Record<string, string> = {
  'model.safetensors': 'fake weights',
  'tokenizer.json': '{"fake":"tokenizer"}',
  'config.json': '{"fake":"config"}',
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

let temporaryDirectory: string;
let cacheHome: string;
let latDir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let stderrWrite: MockInstance<typeof process.stderr.write>;

async function loadModules() {
  const model = await import('../src/fork/multi-qa-search-model.js');
  const embedder = await import('../src/search/embedder.js');
  const fakeMultiQaModel = {
    ...model.multiQaModel,
    weights: {
      name: 'model.safetensors',
      sha256: sha256(fakeFileContents['model.safetensors']),
    },
    tokenizer: {
      name: 'tokenizer.json',
      sha256: sha256(fakeFileContents['tokenizer.json']),
    },
    config: {
      name: 'config.json',
      sha256: sha256(fakeFileContents['config.json']),
    },
  };
  return { ...model, ...embedder, fakeMultiQaModel };
}

function serveFiles(contents: Record<string, string>): void {
  fetchMock.mockImplementation(
    async (url: string) => new Response(contents[basename(url)]),
  );
}

function serveNothing(): void {
  fetchMock.mockRejectedValue(new TypeError('fetch failed'));
}

function stallUntilAborted(): void {
  fetchMock.mockImplementation(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
  );
}

function fillCache(directory: string, contents: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(contents))
    writeFileSync(join(directory, name), content);
}

function stderrLines(): string[] {
  return stderrWrite.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.resetModules();
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'lat-multi-qa-'));
  cacheHome = join(temporaryDirectory, 'cache');
  latDir = join(temporaryDirectory, 'project', 'lat.md');
  mkdirSync(latDir, { recursive: true });
  vi.stubEnv('XDG_CACHE_HOME', cacheHome);
  vi.stubEnv('XDG_CONFIG_HOME', join(temporaryDirectory, 'config'));
  vi.stubEnv('LAT_BUNDLED_EMBEDDING_MODEL', '');
  vi.stubEnv('LAT_LLM_KEY', '');
  vi.stubEnv('LAT_LLM_KEY_FILE', '');
  vi.stubEnv('LAT_LLM_KEY_HELPER', '');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('multi-qa search model', () => {
  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A cache hit needs no network]]
  it('uses cached files without touching the network', async () => {
    const { ensurePinnedModel, pinnedModelCacheDirectory, fakeMultiQaModel } =
      await loadModules();
    const cacheDirectory = pinnedModelCacheDirectory(fakeMultiQaModel);
    fillCache(cacheDirectory, fakeFileContents);

    const manifest = await ensurePinnedModel(fakeMultiQaModel);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(manifest.weightsPath).toBe(
      join(cacheDirectory, 'model.safetensors'),
    );
    expect(manifest.tokenizerPath).toBe(join(cacheDirectory, 'tokenizer.json'));
    expect(manifest.configPath).toBe(join(cacheDirectory, 'config.json'));
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A download is verified and stored]]
  it('downloads, verifies and stores missing files', async () => {
    const { ensurePinnedModel, fakeMultiQaModel } = await loadModules();
    serveFiles(fakeFileContents);

    const manifest = await ensurePinnedModel(fakeMultiQaModel);

    const cacheDirectory = join(
      cacheHome,
      'lat',
      'embedding-models',
      'sentence-transformers',
      'multi-qa-MiniLM-L6-cos-v1',
      fakeMultiQaModel.commit,
    );
    expect(readdirSync(cacheDirectory).sort()).toEqual([
      'config.json',
      'model.safetensors',
      'tokenizer.json',
    ]);
    expect(readFileSync(manifest.weightsPath, 'utf-8')).toBe('fake weights');
    expect(fetchMock.mock.calls.map((call) => call[0]).sort()).toEqual(
      ['config.json', 'model.safetensors', 'tokenizer.json'].map(
        (name) =>
          `https://huggingface.co/sentence-transformers/multi-qa-MiniLM-L6-cos-v1/resolve/${fakeMultiQaModel.commit}/${name}`,
      ),
    );
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#The cache sits in the platform cache folder]]
  it.skipIf(!(process.platform in platformCacheFolders))(
    'caches the model under the platform user cache folder',
    async () => {
      const { pinnedModelCacheDirectory, multiQaModel } = await loadModules();
      vi.stubEnv('XDG_CACHE_HOME', '');

      expect(pinnedModelCacheDirectory(multiQaModel)).toBe(
        join(
          platformCacheFolders[process.platform]!,
          'lat',
          'embedding-models',
          multiQaModel.repository,
          multiQaModel.commit,
        ),
      );
    },
  );

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A corrupt cached file is replaced]]
  it('replaces a cached file whose hash does not match', async () => {
    const { ensurePinnedModel, pinnedModelCacheDirectory, fakeMultiQaModel } =
      await loadModules();
    fillCache(pinnedModelCacheDirectory(fakeMultiQaModel), {
      ...fakeFileContents,
      'model.safetensors': 'corrupt weights',
    });
    serveFiles(fakeFileContents);

    const manifest = await ensurePinnedModel(fakeMultiQaModel);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFileSync(manifest.weightsPath, 'utf-8')).toBe('fake weights');
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A fresh index uses multi-qa]]
  it('gives a fresh index the multi-qa model', async () => {
    const { localEmbedderForIndex, fakeMultiQaModel } = await loadModules();
    serveFiles(fakeFileContents);

    const embedder = await localEmbedderForIndex(null, fakeMultiQaModel);

    expect(embedder.name).toBe(multiQaEmbedderName);
    expect(embedder.dimensions).toBe(384);
    expect(embedder.maxInputTokens).toBe(512);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A bad hash falls back to MiniLM]]
  it('rejects a download with a bad hash and falls back to MiniLM', async () => {
    const {
      localEmbedderForIndex,
      pinnedModelCacheDirectory,
      fakeMultiQaModel,
    } = await loadModules();
    serveFiles({ ...fakeFileContents, 'model.safetensors': 'tampered' });

    const embedder = await localEmbedderForIndex(null, fakeMultiQaModel);

    expect(embedder.name).toBe(miniLmEmbedderName);
    expect(
      existsSync(
        join(pinnedModelCacheDirectory(fakeMultiQaModel), 'model.safetensors'),
      ),
    ).toBe(false);
    expect(stderrLines().join('')).toContain('SHA-256');
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#Offline falls back to MiniLM with one warning]]
  it('falls back to MiniLM with one warning when offline', async () => {
    const { embedderForIndex, localEmbedder } = await loadModules();
    serveNothing();

    const freshIndexEmbedder = await embedderForIndex(null, latDir);
    const reindexEmbedder = await localEmbedder();

    expect(freshIndexEmbedder.name).toBe(miniLmEmbedderName);
    expect(reindexEmbedder.name).toBe(miniLmEmbedderName);
    const warnings = stderrLines().filter((line) =>
      line.includes('all-MiniLM-L6-v2'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^[^\n]+\n$/);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A stalled download times out like offline]]
  it('treats a stalled download as offline once the timeout passes', async () => {
    const {
      embedderForIndex,
      modelDownloadTimeoutMilliseconds,
      ReindexRequiredError,
    } = await loadModules();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => realTimeout(10));
    stallUntilAborted();

    const freshIndexEmbedder = await embedderForIndex(null, latDir);

    expect(freshIndexEmbedder.name).toBe(miniLmEmbedderName);
    expect(timeout).toHaveBeenCalledWith(modelDownloadTimeoutMilliseconds);
    expect(
      stderrLines().filter((line) => line.includes('all-MiniLM-L6-v2')),
    ).toHaveLength(1);
    await expect(
      embedderForIndex(multiQaStoredModel, latDir),
    ).rejects.toBeInstanceOf(ReindexRequiredError);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A hook process never downloads]]
  it('requires a reindex instead of downloading in a hook process', async () => {
    const {
      embedderForIndex,
      neverDownloadModelInThisProcess,
      ReindexRequiredError,
    } = await loadModules();
    serveFiles(fakeFileContents);
    neverDownloadModelInThisProcess();

    await expect(
      embedderForIndex(multiQaStoredModel, latDir),
    ).rejects.toBeInstanceOf(ReindexRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#The prompt hook turns downloads off]]
  it('never downloads when the prompt hook searches a multi-qa index', async () => {
    const { openDb, ensureMeta, setStoredModel, closeDb } =
      await import('../src/search/db.js');
    const { LEXICAL_VERSION } = await import('../src/search/lexical.js');
    const { hookCmd } = await import('../src/cli/hook.js');
    serveFiles(fakeFileContents);
    writeFileSync(
      join(latDir, 'notes.md'),
      '# Notes\n\nA short note about search.\n',
    );
    const db = openDb(latDir);
    try {
      await ensureMeta(db);
      await setStoredModel(db, multiQaStoredModel);
      await db.execute({
        sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)',
        args: ['lexical_version', LEXICAL_VERSION],
      });
    } finally {
      await closeDb(db);
    }
    vi.spyOn(process, 'cwd').mockReturnValue(join(latDir, '..'));
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([
        Buffer.from(JSON.stringify({ prompt: 'how does search work' })),
      ]) as unknown as typeof process.stdin,
    );
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await hookCmd('claude', 'UserPromptSubmit');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A stored MiniLM index keeps MiniLM]]
  it('keeps MiniLM for an index that records MiniLM', async () => {
    const { embedderForIndex } = await loadModules();

    const embedder = await embedderForIndex(miniLmStoredModel, latDir);

    expect(embedder.name).toBe(miniLmEmbedderName);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A stored multi-qa index resolves multi-qa]]
  it('resolves multi-qa for an index that records multi-qa', async () => {
    const {
      localEmbedderForIndex,
      pinnedModelCacheDirectory,
      fakeMultiQaModel,
    } = await loadModules();
    fillCache(pinnedModelCacheDirectory(fakeMultiQaModel), fakeFileContents);

    const embedder = await localEmbedderForIndex(
      multiQaStoredModel,
      fakeMultiQaModel,
    );

    expect(embedder.name).toBe(multiQaEmbedderName);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A stored multi-qa index never falls back]]
  it('requires a reindex when a multi-qa index cannot load its model', async () => {
    const { embedderForIndex, ReindexRequiredError } = await loadModules();
    serveNothing();

    const attempt = embedderForIndex(multiQaStoredModel, latDir);

    await expect(attempt).rejects.toBeInstanceOf(ReindexRequiredError);
    await expect(attempt).rejects.toThrow(/lat reindex/);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#Remote behaviour is unchanged]]
  it('leaves remote behaviour unchanged', async () => {
    const { embedderForIndex, embedderFromEnv, ReindexRequiredError } =
      await loadModules();

    await expect(
      embedderForIndex('openai:1536', latDir),
    ).rejects.toBeInstanceOf(ReindexRequiredError);

    vi.stubEnv('LAT_LLM_KEY', 'sk-test-key');
    expect((await embedderForIndex(null, latDir)).name).toBe('openai');
    expect((await embedderForIndex('openai:1536', latDir)).name).toBe('openai');
    expect((await embedderFromEnv()).name).toBe('openai');
    expect((await embedderForIndex(miniLmStoredModel, latDir)).name).toBe(
      miniLmEmbedderName,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#The bundled-model switch skips the download]]
  it('keeps fresh indexes on MiniLM when the bundled model is requested', async () => {
    const { embedderForIndex } = await loadModules();
    vi.stubEnv('LAT_BUNDLED_EMBEDDING_MODEL', '1');

    const embedder = await embedderForIndex(null, latDir);

    expect(embedder.name).toBe(miniLmEmbedderName);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A process can pin the bundled model]]
  it('keeps fresh indexes on MiniLM once a process pins the bundled model', async () => {
    const { embedderForIndex, useBundledModelForFreshIndexes } =
      await loadModules();
    useBundledModelForFreshIndexes();

    const embedder = await embedderForIndex(null, latDir);

    expect(embedder.name).toBe(miniLmEmbedderName);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#lat init downloads the model]]
  it('downloads the model for lat init', async () => {
    const {
      downloadDefaultSearchModel,
      pinnedModelCacheDirectory,
      fakeMultiQaModel,
    } = await loadModules();
    serveFiles(fakeFileContents);

    await downloadDefaultSearchModel(null, fakeMultiQaModel);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      readdirSync(pinnedModelCacheDirectory(fakeMultiQaModel)).sort(),
    ).toEqual(['config.json', 'model.safetensors', 'tokenizer.json']);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#lat init skips the download for a MiniLM index]]
  it('skips the lat init download for an index that records MiniLM', async () => {
    const { downloadDefaultSearchModel, fakeMultiQaModel } =
      await loadModules();
    serveFiles(fakeFileContents);

    await downloadDefaultSearchModel(miniLmStoredModel, fakeMultiQaModel);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#lat init downloads for a multi-qa index]]
  it('downloads the model for lat init when the index records multi-qa', async () => {
    const { downloadDefaultSearchModel, fakeMultiQaModel } =
      await loadModules();
    serveFiles(fakeFileContents);

    await downloadDefaultSearchModel(multiQaStoredModel, fakeMultiQaModel);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#lat init skips the download for the bundled model]]
  it('skips the lat init download when the bundled model is requested', async () => {
    const { downloadDefaultSearchModel, fakeMultiQaModel } =
      await loadModules();
    vi.stubEnv('LAT_BUNDLED_EMBEDDING_MODEL', '1');
    serveFiles(fakeFileContents);

    await downloadDefaultSearchModel(null, fakeMultiQaModel);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#A failed lat init download warns and continues]]
  it('warns once and returns when the lat init download fails', async () => {
    const { downloadDefaultSearchModel, fakeMultiQaModel } =
      await loadModules();
    serveNothing();

    await expect(
      downloadDefaultSearchModel(null, fakeMultiQaModel),
    ).resolves.toBeUndefined();

    const warnings = stderrLines().filter((line) =>
      line.includes('all-MiniLM-L6-v2'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('fetch failed');
  });

  // @lat: [[tests/fork-multi-qa-search-model#Fork Multi-QA Search Model#The server index build stays on MiniLM]]
  it('builds the server index with MiniLM and no download', async () => {
    const { analyzeMarkdownProject } =
      await import('@plebeiantech/lat.md-core/project-analysis');
    const { openDb, getStoredModel, closeDb } =
      await import('../src/search/db.js');
    serveNothing();
    writeFileSync(
      join(latDir, 'notes.md'),
      '# Notes\n\nA short note about search.\n',
    );
    const project = await analyzeMarkdownProject(latDir, join(latDir, '..'), {
      executor: 'auto',
    });
    const cacheDir = join(temporaryDirectory, 'server-index');
    const exitCode = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        resolve(code);
      }) as typeof process.exit);
    });

    const listenersBeforeImport = process.listeners('message');
    await import('../src/view/server-index-worker.js');
    const workerListener = process
      .listeners('message')
      .find((listener) => !listenersBeforeImport.includes(listener));
    if (!workerListener) throw new Error('the worker added no listener');
    process.off('message', workerListener);
    await workerListener({ latDir, project, cacheDir }, undefined);

    expect(await exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const db = openDb(latDir, cacheDir, true);
    try {
      expect(await getStoredModel(db)).toBe(miniLmStoredModel);
    } finally {
      await closeDb(db);
    }
  }, 120_000);
});
