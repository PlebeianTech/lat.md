---
lat:
  require-code-mention: true
---

# Fork Codebase Memory Store

Tests in [[tests/fork-codebase-memory-store.test.ts]] for
[[src/fork/adapters/codebase-memory-store.ts]], the external store adapter for
codebase-memory-mcp. Each test runs the adapter as a child process with the
fake binary `tests/fixtures/codebase-memory-bin/codebase-memory-mcp` first on
`PATH`. See [[use-codebase-memory-store]].

## Query hits come from search_graph

The adapter runs `search_graph` once per term. A hit's `key` and `title` are
the qualified name, `detail` is `file:line`, and `score` is the number of
terms that matched. Higher scores come first.

## A hit without a line number names the file

A node with no line range, such as a file node, gets the file path alone as
its `detail`, with no trailing colon.

## Hits are capped at the limit

The adapter prints at most `limit` hits, keeping the highest scores.

## Arguments reach the binary as separate entries

The binary receives each flag and value as its own argument, so no shell
sees them. A term such as `a.b*` arrives regex-escaped as `a\.b\*`.

## A missing binary gives no hits

With no `codebase-memory-mcp` on `PATH`, the adapter prints `[]` and exits 0.

## An unindexed project gives no hits

When no project from `list_projects` has `projectRoot` as its root, the
adapter prints `[]`, exits 0 and runs no search.

## Unreadable output gives no hits

When `list_projects` or `search_graph` prints output that is not the expected
JSON, the adapter prints `[]` and exits 0.

## Only the query operation is answered

For any other operation the adapter prints `[]`, exits 0 and does not run the
binary.
