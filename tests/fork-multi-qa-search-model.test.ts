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
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const miniLmEmbedderName = 'local:minilm-l6-v2';
const miniLmStoredModel = 'local:minilm-l6-v2:384';
const multiQaEmbedderName = 'local:multi-qa-minilm-l6-cos-v1';
const multiQaStoredModel = 'local:multi-qa-minilm-l6-cos-v1:384';

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
});
