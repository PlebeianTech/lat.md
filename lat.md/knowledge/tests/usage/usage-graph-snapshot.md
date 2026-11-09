---
lat:
  require-code-mention: true
---

# Usage Graph Snapshot

Tests in `tests/usage-graph-snapshot.test.ts` for `src/fork/usage/graph-snapshot.ts`.

They build a fixture `lat.md` directory in a temporary git repository, commit it, and feed the aggregation usage events that carry the commit as their `git_head`. None reads the real project graph.

## The snapshot lists every section, document and code-ref edge

The snapshot of a head lists each section id with its byte size and content hash, each document with its bytes, and each edge from a source file line to the section it references with `@lat`.

Code-ref edges are read from a worktree that is at that head.

## A second call at the same head reuses the cache

The snapshot of a head is stored once in `.lat/usage/graph-snapshots` when `.lat/usage/` exists. A later aggregation at the same head reads that file and does not build the graph again.

## Never-read sections exclude sections read in range

The never-read list holds the sections of the snapshot at the latest head in the range that no `lat section` command in the range opened.

## A section deleted at a later head is not reported

A section that an earlier head had and the latest head lacks is not in the never-read list, because the list is taken against the latest head only.

## A section hash is stable until its text changes

The content hash of a section is the same at two heads when its text is the same, and differs when its text changed.

## A past head without a worktree stores no code-ref edges

When no worktree named by the events is at a head, the snapshot has `code_ref_edges` null and the reason `not_captured`, because code refs come from the live working tree.

## Symbol-ref edges are stored for past and current heads

Sections that cite a source file as `file#symbol` give a symbol-ref edge keyed by the file part of the target. These come from markdown, so a past head has them too.

## Documents carry bytes and reads

Each document row has its bytes, the count of section reads in range that fall in it, and the number of its distinct sections read.

## A loaded snapshot is not read again in the same process

Once a head's snapshot is loaded, a later summary in the same process takes it from memory and does not read the cache file again.

## Heads outside the range are not built

Snapshots are loaded or built only for the git heads of events in the selected range.

## A corrupt cache file is rebuilt

A cache file that does not parse is deleted and the snapshot is built again. Cache files are written to a temporary file and renamed.

## A head git cannot show has no snapshot and a reason

A head that git cannot list gives a null snapshot with the failure reason, once per process, and the reason is in the result rather than skipped.

## A dirty worktree stores no code-ref edges

A worktree at the head with uncommitted changes proves only the commit, not the tree the code refs were read from. The snapshot then has `code_ref_edges` null and the reason `dirty_worktree`.

## A project below the repository root gets snapshots

A project whose root is `proj/` inside its git repository gets a real snapshot of a head: its two documents, their section ids, the code-ref edge from `src/a.ts` and the symbol-ref edge, all relative to the project root.

The fork reads each file at the head as `<head>:./<path>` from the project root, so git resolves it there.

Upstream `loadRevisionFiles` in [[src/graph-export.ts]] lists paths relative to the project root but shows them from the repository top, so it fails below the top. That upstream defect is recorded as no-action; the fork does not call it.
