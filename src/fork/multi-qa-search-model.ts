import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import xdg from '@folder/xdg';
import {
  createEmbedder,
  type Embedder,
  type ModelManifest,
} from '@lat.md/embed';
import bundledMiniLmManifest from '@lat.md/embed-minilm-fp16';
import { ReindexRequiredError } from '../search/embedder.js';

export type PinnedModelFile = { name: string; sha256: string };

export type PinnedModel = {
  id: string;
  displayName: string;
  repository: string;
  commit: string;
  dimensions: number;
  maxTokens: number;
  weights: PinnedModelFile;
  tokenizer: PinnedModelFile;
  config: PinnedModelFile;
};

// @lat: [[multi-qa-search-model#Multi-QA Search Model#Where the weights come from]]
export const multiQaModel: PinnedModel = {
  id: 'multi-qa-minilm-l6-cos-v1',
  displayName: 'multi-qa-MiniLM-L6-cos-v1',
  repository: 'sentence-transformers/multi-qa-MiniLM-L6-cos-v1',
  commit: 'b207367332321f8e44f96e224ef15bc607f4dbf0',
  dimensions: 384,
  maxTokens: 512,
  weights: {
    name: 'model.safetensors',
    sha256: '7bec4fd9eba43073d5c5dcf1b79b0a3397608fa063e6f626d6f8fd70a81f2d8c',
  },
  tokenizer: {
    name: 'tokenizer.json',
    sha256: '7fa9272f7ef1ebd1666bb3bfd9d4707660ff0076ca9d1671cd9a9c6e18e03331',
  },
  config: {
    name: 'config.json',
    sha256: '953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41',
  },
};

export const bundledModelEnvironmentVariable = 'LAT_BUNDLED_EMBEDDING_MODEL';

// @lat: [[multi-qa-search-model#Multi-QA Search Model#When the download fails]]
export const modelDownloadTimeoutMilliseconds = 10 * 60 * 1000;

let processUsesBundledModel = false;
let processMayDownloadModel = true;
let fallbackWarningShown = false;
let downloadNoticeShown = false;

// @lat: [[multi-qa-search-model#Multi-QA Search Model#Staying on the bundled model]]
export function useBundledModelForFreshIndexes(): void {
  processUsesBundledModel = true;
}

// @lat: [[multi-qa-search-model#Multi-QA Search Model#Hooks never download]]
export function neverDownloadModelInThisProcess(): void {
  processMayDownloadModel = false;
}

function bundledModelRequested(): boolean {
  return (
    processUsesBundledModel ||
    process.env[bundledModelEnvironmentVariable] === '1'
  );
}

// @lat: [[multi-qa-search-model#Multi-QA Search Model#The cache]]
export function pinnedModelCacheDirectory(model: PinnedModel): string {
  return join(
    xdg().cache,
    'lat',
    'embedding-models',
    model.repository,
    model.commit,
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function cachedFileIsVerified(
  path: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === expectedSha256;
  } catch {
    return false;
  }
}

function announceDownloadOnce(
  model: PinnedModel,
  cacheDirectory: string,
): void {
  if (downloadNoticeShown) return;
  downloadNoticeShown = true;
  process.stderr.write(
    `lat: downloading the ${model.displayName} search model to ${cacheDirectory} (first use only).\n`,
  );
}

async function downloadVerifiedFile(
  model: PinnedModel,
  file: PinnedModelFile,
  cacheDirectory: string,
): Promise<void> {
  const url = `https://huggingface.co/${model.repository}/resolve/${model.commit}/${file.name}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(modelDownloadTimeoutMilliseconds),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  announceDownloadOnce(model, cacheDirectory);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256)
    throw new Error(`${url} does not match its pinned SHA-256`);

  await mkdir(cacheDirectory, { recursive: true });
  const destinationPath = join(cacheDirectory, file.name);
  const temporaryPath = `${destinationPath}.${randomUUID()}.partial`;
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// @lat: [[multi-qa-search-model#Multi-QA Search Model#Where the weights come from]]
export async function ensurePinnedModel(
  model: PinnedModel,
): Promise<ModelManifest> {
  const cacheDirectory = pinnedModelCacheDirectory(model);
  for (const file of [model.weights, model.tokenizer, model.config]) {
    const cachedPath = join(cacheDirectory, file.name);
    if (await cachedFileIsVerified(cachedPath, file.sha256)) continue;
    if (!processMayDownloadModel)
      throw new Error(`${cachedPath} is missing or corrupt`);
    await downloadVerifiedFile(model, file, cacheDirectory);
  }
  return {
    id: model.id,
    dimensions: model.dimensions,
    maxTokens: model.maxTokens,
    pooling: 'mean',
    normalize: true,
    weightsPath: join(cacheDirectory, model.weights.name),
    tokenizerPath: join(cacheDirectory, model.tokenizer.name),
    configPath: join(cacheDirectory, model.config.name),
  };
}

function storedModelKey(model: { id: string; dimensions: number }): string {
  return `local:${model.id}:${model.dimensions}`;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// @lat: [[multi-qa-search-model#Multi-QA Search Model#When the download fails]]
function warnAboutFallbackOnce(model: PinnedModel, error: unknown): void {
  if (fallbackWarningShown) return;
  fallbackWarningShown = true;
  process.stderr.write(
    `lat: could not get the ${model.displayName} search model (${failureReason(error)}), so this index uses the bundled all-MiniLM-L6-v2 model.\n`,
  );
}

// @lat: [[multi-qa-search-model#Multi-QA Search Model#lat init fetches the model]]
export async function downloadDefaultSearchModel(
  storedModel?: string | null,
  model: PinnedModel = multiQaModel,
): Promise<void> {
  if (bundledModelRequested() || !processMayDownloadModel) return;
  const indexKeepsAnotherLocalModel =
    storedModel?.startsWith('local:') && storedModel !== storedModelKey(model);
  if (indexKeepsAnotherLocalModel) return;
  try {
    await ensurePinnedModel(model);
  } catch (error) {
    process.stderr.write(
      `lat: could not download the ${model.displayName} search model (${failureReason(error)}). 'lat search' tries again on first use and falls back to the bundled all-MiniLM-L6-v2 model if that fails too.\n`,
    );
  }
}

// @lat: [[multi-qa-search-model#Multi-QA Search Model#Which model an index uses]]
export async function localEmbedderForIndex(
  storedModel?: string | null,
  model: PinnedModel = multiQaModel,
): Promise<Embedder> {
  const bundledEmbedder = () =>
    createEmbedder({ model: bundledMiniLmManifest });

  if (storedModel === storedModelKey(model)) {
    try {
      return await createEmbedder({ model: await ensurePinnedModel(model) });
    } catch (error) {
      throw new ReindexRequiredError(
        `This index was built with '${storedModel}', but that model could not be loaded (${failureReason(error)}). ` +
          `Restore the network connection and retry, or run 'lat reindex' to rebuild.`,
      );
    }
  }

  if (storedModel || bundledModelRequested()) return bundledEmbedder();

  try {
    return await createEmbedder({ model: await ensurePinnedModel(model) });
  } catch (error) {
    warnAboutFallbackOnce(model, error);
    return bundledEmbedder();
  }
}
