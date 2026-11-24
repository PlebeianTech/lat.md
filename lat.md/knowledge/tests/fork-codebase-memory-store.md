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

## Only query and callers are answered

For any other operation the adapter prints `[]`, exits 0 and does not run the
binary.

## Callers come from trace_path

For a `callers` request the adapter finds each symbol, runs `trace_path`
inbound at the requested depth and prints `{symbol, callers}`.

Each caller has the project-relative `file`, a `name` and the start `line`
that CBM reports. A caller that is a method is named `Class#method`.

## A callers request passes separate argv entries

The binary receives each flag and value as its own argument: the symbol search
scoped to the file, the inbound trace with the depth, and one search by
qualified name for all callers.

## A class name picks the method

A file with a top-level function and a method of the same name gives two
nodes. The lat name `Greeter#greet` picks the node whose qualified name
prefix ends in `Greeter`, and the bare name `greet` picks the top-level one.

## An unknown symbol is omitted

A symbol that CBM has no node for in the requested file is left out of the
answer, as is one that matches only by case or only in another file. The
other symbols still return. A symbol that is found and has no callers returns
an empty `callers` list.

## A failing symbol is omitted

A symbol whose `trace_path` call fails is left out of the answer, and the
other symbols still return. One failing CBM call costs only its own symbol.

## Only the first four symbols are answered

A request for five symbols answers the first four, in request order, and
makes no CBM call for the fifth.

## A missing binary gives no callers

With no `codebase-memory-mcp` on `PATH`, a `callers` request prints `[]` and
exits 0.

## Unreadable output gives no callers

Unreadable `list_projects` output makes a `callers` request print `[]` and
exit 0. Unreadable `search_graph` or `trace_path` output drops its symbol, so
a request for that symbol alone prints `[]`.

A `trace_path` reply for an ambiguous name, which has no `callers`, counts as
unreadable.

## An unindexed project gives no callers

When no project from `list_projects` has `projectRoot` as its root, a
`callers` request prints `[]`, exits 0 and runs no search.
