---
lat:
  require-code-mention: true
---

# Fork Decision Model Rerank

Tests in [[tests/fork-decision-model-rerank.test.ts]] for [[src/fork/decision-model-rerank.ts]], which reorders `lat search` results with a decision model. `fetch` is mocked, so no test reaches the network.

## Orders matches by the returned probability

The match with the highest probability comes first, and each reranked match carries its probability in its diagnostics for `--debug`.

## Ties keep search order

Two matches with equal probabilities keep the order search gave them, so a flat answer never shuffles results.

## Retrieves at least ten candidates and returns the limit

The candidate count is the larger of the limit and ten, every candidate is asked about once, and only `limit` matches come back.

## A limit below one keeps the limit error

With `--rerank`, a limit of 0 or -1 passes through [[src/fork/decision-model-rerank.ts#rerankCandidateCount]] unchanged, so search raises its usual "limit must be a positive integer" error instead of searching ten candidates.

## Sends the request body the decision model expects

Each request is a JSON `POST` with the query, the heading path and section text, and the `noul` question. `LAT_RERANK_MODEL` sets the model and `LAT_RERANK_KEY` sets a bearer header.

Without those variables the model is `default` and no header is sent. Section text stops at 1,200 characters.

## Falls back to search order when the decision model fails

A network error, an HTTP error, a redirect, a malformed or out-of-range probability, and a timeout each produce the first `limit` matches in search order and exactly one stderr warning.

The redirect comes from a local test server. The timeout runs on fake timers, so the test does not wait ten seconds.

## Rejects a value that is not an HTTP URL

`http:` and `https:` URLs pass. A bare host, plain text and an `ftp:` URL raise commander's argument error.

## Rejects a URL with a user name or password

A URL with a user name, a password or both raises an argument error that points to `LAT_RERANK_KEY`, so a key never sits in a URL.

## Never prints a key that cannot go in a header

A `LAT_RERANK_KEY` with a line break stops the rerank before any request. The results keep search order, and the one warning does not contain the key.

## Leaves search unchanged without the flag

Without a URL, the candidate count equals the limit and the matches come back as the same array, with no request and no warning.

## The search command applies the reranker

`searchCommand` on a copy of the `rag` fixture prints the plain order without the flag and makes no request. With the flag it prints the section the mocked model favours first and shows its probability in `--debug` output.
