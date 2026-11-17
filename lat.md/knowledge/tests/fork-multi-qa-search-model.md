---
lat:
  require-code-mention: true
---

# Fork Multi-QA Search Model

Tests in [[tests/fork-multi-qa-search-model.test.ts]] and [[tests/fork-multi-qa-search-model-init.test.ts]] for [[src/fork/multi-qa-search-model.ts]], which downloads the default local search model and decides which model each index uses. `fetch` is mocked, so no test reaches the network.

## A cache hit needs no network

With all three files in the cache and their hashes correct, [[src/fork/multi-qa-search-model.ts#ensurePinnedModel]] returns a manifest that points at them and never calls `fetch`.

## A download is verified and stored

With an empty cache, the three files are fetched from URLs pinned to the model commit and stored under the cache directory that carries the repository name and that commit. No temporary file is left behind.

## The cache sits in the platform cache folder

With `XDG_CACHE_HOME` unset, [[src/fork/multi-qa-search-model.ts#pinnedModelCacheDirectory]] sits under `~/Library/Caches` on macOS and `~/.cache` on Linux. The test compares against those literal folders, not the `@folder/xdg` call the code makes, and skips other platforms.

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

## A hook process never downloads

After [[src/fork/multi-qa-search-model.ts#neverDownloadModelInThisProcess]] runs, an index that records multi-qa with an empty cache rejects with [[src/search/embedder.ts#ReindexRequiredError]] and `fetch` is never called.

## The prompt hook turns downloads off

The real [[src/cli/hook.ts#hookCmd]] handles a prompt event against an index that records multi-qa, with an empty model cache and `LAT_BUNDLED_EMBEDDING_MODEL` cleared. It never calls `fetch`, so removing its `neverDownloadModelInThisProcess()` call fails the test.

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

## lat init downloads the model

[[src/fork/multi-qa-search-model.ts#downloadDefaultSearchModel]] fetches and stores all three files when the cache is empty, so the first agent search does not have to.

## lat init skips the download for a MiniLM index

Given an index that records `local:minilm-l6-v2:384`, [[src/fork/multi-qa-search-model.ts#downloadDefaultSearchModel]] makes no request and prints nothing, because that index keeps MiniLM.

## lat init downloads for a multi-qa index

Given an index that records the multi-qa model, the `lat init` download still fetches all three files, so the early return covers only other local models.

## A real lat init downloads for a fresh repo

The real [[src/cli/init.ts#initCmd]] runs without a terminal on a repo with no index and requests the model from Hugging Face, so removing its download call fails the test.

## Re-running lat init fetches a missing model

The real [[src/cli/init.ts#initCmd]] runs on a repo already at the current init version, with no index and no cached model, and still requests the model, so a re-run can restore a lost cache.

## A real lat init skips the download for a MiniLM index

The real [[src/cli/init.ts#initCmd]] runs without a terminal on a repo whose index records MiniLM and never requests the model, so dropping the stored model from its download call fails the test.

## lat init skips the download for the bundled model

With `LAT_BUNDLED_EMBEDDING_MODEL=1`, the `lat init` download makes no request and prints nothing.

## A failed lat init download warns and continues

When the network fails, the `lat init` download resolves without an error and prints one warning that names the cause and the bundled fallback.

## The server index build stays on MiniLM

The real [[src/view/server-index-worker.ts]] handler builds an index in process with `fetch` rejecting and `LAT_BUNDLED_EMBEDDING_MODEL` cleared. It never calls `fetch` and records MiniLM, so removing its `useBundledModelForFreshIndexes()` call fails the test.
