# Multi-QA Search Model

Local search embeds with `sentence-transformers/multi-qa-MiniLM-L6-cos-v1`, downloaded on first use. The bundled all-MiniLM-L6-v2 stays as the fallback and as the model every older index keeps.

People ask `lat search` questions, and this model was trained on question and answer pairs. On a real 172-page tree it ranked the right section first for 9 of 32 plain-English questions. MiniLM managed 5.

The switch costs nothing at run time. Both models are six-layer BERT encoders with mean pooling and 384 dimensions, so the local WASM engine loads [[src/fork/multi-qa-search-model.ts#multiQaModel]] unchanged through a `ModelManifest`. It reads 512 tokens where MiniLM reads 256.

## Which model an index uses

The model an index records decides which model searches it. [[src/fork/multi-qa-search-model.ts#localEmbedderForIndex]] makes that choice for every local path in [[src/search/embedder.ts]].

A fresh index gets multi-qa, and so does `lat reindex`. An index that records `local:minilm-l6-v2:384` keeps MiniLM, with no error and no download, until `lat reindex` rebuilds it. That is how an existing index switches.

An index that records multi-qa always loads multi-qa. Vectors from two models cannot be compared, so when the weights cannot be loaded the search stops with [[src/search/embedder.ts#ReindexRequiredError]] instead of answering with MiniLM.

Hosted embeddings are untouched. A key still selects the hosted backend exactly as [[rag-architecture#Embedding backends]] describes.

## Where the weights come from

Lat downloads three files from Hugging Face: `model.safetensors`, `tokenizer.json` and `config.json`. [[src/fork/multi-qa-search-model.ts#ensurePinnedModel]] fetches each one that the cache lacks, and lat prints one line on stderr when a download starts.

MiniLM's weights reach users as upstream's `@lat.md/embed-minilm-fp16` npm package. The fork cannot publish under that scope, and 87 MB of weights do not belong in the CLI tarball, so a second model needs another road.

The download is pinned twice. Each URL names one exact commit of the model repository, and the code holds a SHA-256 for each file. Lat hashes the bytes before it writes them, so a file that changed upstream or in transit is never stored and never used.

## The cache

The files live in the user cache, in a directory named by [[src/fork/multi-qa-search-model.ts#pinnedModelCacheDirectory]]. One download serves every project on the machine.

```
<user cache>/lat/embedding-models/sentence-transformers/multi-qa-MiniLM-L6-cos-v1/<commit>/
```

The user cache is the platform's cache folder from `@folder/xdg`: `XDG_CACHE_HOME` when set, otherwise `~/Library/Caches` on macOS and `~/.cache` on Linux. The path carries the repository name and the pinned commit, so a later pin gets its own directory and never reads files from an older one.

Each file is written under a temporary name and then renamed. A rename is atomic, so two lat processes that download at once cannot leave a half-written file behind.

Lat hashes the cached files again on every load, which takes about 40 ms. A cached file that fails the check is downloaded again.

## When the download fails

A fresh index that cannot get the model uses the bundled MiniLM, and lat says so once on stderr in one sentence. No network, an HTTP error and a bad hash all take this path.

So does a file that has not arrived within [[src/fork/multi-qa-search-model.ts#modelDownloadTimeoutMilliseconds]], ten minutes: a line of 1.2 megabits per second still delivers the 91 MB weights in that time, and a stalled connection cannot hang a search.

The index then records MiniLM, so every later search uses MiniLM without another download attempt. Once the network is back, `lat reindex` moves the index to multi-qa.

## Staying on the bundled model

Two callers must never download, and both keep fresh indexes on the bundled MiniLM.

`lat ui build server` ships its index beside a server that imports `@lat.md/embed-minilm-fp16` and cannot download at run time. An index built with multi-qa would be searched with MiniLM vectors there. So [[src/view/server-index-worker.ts]] calls [[src/fork/multi-qa-search-model.ts#useBundledModelForFreshIndexes]] before it indexes.

The environment variable `LAT_BUNDLED_EMBEDDING_MODEL=1` does the same for any process. The test suite sets it through [[src/fork/vitest-pool-options.ts#forkTestEnvironment]], so no test reaches the network. A machine with no network access can set it to skip the attempt and the warning.

Neither switch changes an index that already records multi-qa. Test spec: [[tests/fork-multi-qa-search-model]].
