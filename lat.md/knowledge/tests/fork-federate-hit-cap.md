---
lat:
  require-code-mention: true
---

# Fork Federate Hit Cap

Tests in [[tests/knowledge/federate-hit-cap.test.ts]] for the total hit cap
that [[src/knowledge/index.ts#federateTags]] applies to one prompt. See
[[knowledge-federation#Hit Budget]].

## Default cap keeps nine hits in document order

Three documents, each with three fake stores returning three hits, produce
exactly nine hit lines. Earlier documents keep their hits first.

## A fully cut document is neither emitted nor seen

When the cap leaves a document with no hits, its block is absent from the
output and its id is absent from `seen`, so a later prompt can surface it.

## Below the cap output is unchanged

With fewer hits than the cap, the output is exactly the text produced
before the cap existed.

## An explicit cap overrides the default

`maxTotalHits` replaces the default of nine, both lower and higher.
