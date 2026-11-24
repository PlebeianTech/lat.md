---
lat:
  require-code-mention: true
---

# Fork Federate Decision Filter

Tests in [[tests/knowledge/federate-decision-filter.test.ts]] for the decision
filter that [[src/knowledge/index.ts#federateTags]] applies to store hits when
it gets a prompt. Each test runs a local HTTP server as the decision model and
sets `LAT_FEDERATION_RERANK_URL` to it. See
[[knowledge-federation#Decision Filter]].

## Hits scored below one half are dropped in order

The server scores hits that mention "noise" 0.1 and the others 0.9. The noise
hit is absent from the output, and the other hits keep their order.

## Each request carries the prompt and the hit text

The request's question is the prompt cut at 1,200 characters. Its section
text has the store label, the hit title and the hit detail. The instructions
ask about what the user asked a coding agent to do.

## A failing model keeps every hit

When the server answers HTTP 500, the output is the same as without the
filter, and nothing is written to stdout or stderr.

## Nothing is sent after the deadline

When the federation deadline passes while the stores answer, the server gets
no request, the output is the same as without the filter, and no warning is
emitted.

## Nothing is sent without a prompt and a valid URL

Without the variable, without a prompt, or with an `ftp:` URL in the
variable, the server gets no request, nothing throws, and the output is the
same as without the filter.

## A document emptied by the filter is attempted empty

When every hit of a document is dropped, federation returns null, and the
document is in `attemptedEmpty` but not in `seen`.

## Requests run in parallel

Five hits on a server that waits 400 ms per answer finish in well under the
time of five sequential requests.

## Caller lines are never sent to the model

A document with a linked symbol shows its `Callers (LABEL):` group, and no
request body contains the caller's name.

## An emptied document frees its emitted slot

With `maxEmitted` 1, the first document's hits are all dropped, so the second
document is emitted and is the only one in `seen`.
