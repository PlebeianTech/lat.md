---
lat:
  require-code-mention: true
---

# Fork Multi-QA Search Model

Tests in [[tests/fork-multi-qa-search-model.test.ts]] for [[src/fork/multi-qa-search-model.ts]], which downloads the default local search model and decides which model each index uses. `fetch` is mocked, so no test reaches the network.

## A cache hit needs no network

With all three files in the cache and their hashes correct, [[src/fork/multi-qa-search-model.ts#ensurePinnedModel]] returns a manifest that points at them and never calls `fetch`.

## A download is verified and stored

With an empty cache, the three files are fetched from URLs pinned to the model commit and stored under the cache directory that carries the model id and that commit. No temporary file is left behind.

## A corrupt cached file is replaced

A cached file whose hash does not match is never used. Only that file is fetched again, and the verified copy replaces it.

## A fresh index uses multi-qa

With no stored model, [[src/fork/multi-qa-search-model.ts#localEmbedderForIndex]] returns the multi-qa embedder with 384 dimensions and a 512-token input limit.

## A bad hash falls back to MiniLM

When a downloaded file does not match its pinned SHA-256, nothing is stored at the final path, and a fresh index gets the bundled MiniLM with a warning that names the hash.

## Offline falls back to MiniLM with one warning

When `fetch` fails, a fresh index and `lat reindex` both get the bundled MiniLM. Two failures in one process write one warning, and the warning is one line.

## A stalled download times out like offline

When `fetch` never answers, the request is aborted after [[src/fork/multi-qa-search-model.ts#modelDownloadTimeoutMilliseconds]]. A fresh index then gets the bundled MiniLM with one warning, and an index that records multi-qa rejects with [[src/search/embedder.ts#ReindexRequiredError]]. The test shortens the timeout, so it does not wait.

## A stored MiniLM index keeps MiniLM

An index that records `local:minilm-l6-v2:384` resolves MiniLM through [[src/search/embedder.ts#embedderForIndex]] with no network call and nothing on stderr, so existing indexes keep working.

## A stored multi-qa index resolves multi-qa

An index that records the multi-qa model resolves the multi-qa embedder from the cache.

## A stored multi-qa index never falls back

When an index records multi-qa and the model cannot be loaded, [[src/search/embedder.ts#embedderForIndex]] rejects with [[src/search/embedder.ts#ReindexRequiredError]] and a message that names `lat reindex`. It never mixes models.

## Remote behaviour is unchanged

A hosted index with no key still requires a reindex. With a key, a fresh index and a hosted index resolve the hosted embedder, a local MiniLM index still ignores the key, and no model download is attempted.

## The bundled-model switch skips the download

With `LAT_BUNDLED_EMBEDDING_MODEL=1`, a fresh index gets the bundled MiniLM with no network call and no warning. The whole suite relies on this to stay offline.

## A process can pin the bundled model

After [[src/fork/multi-qa-search-model.ts#useBundledModelForFreshIndexes]] runs, a fresh index gets the bundled MiniLM with no network call. The server index build relies on this.
