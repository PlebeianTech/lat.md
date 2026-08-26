---
lat:
  require-code-mention: true
---
# Graph

Functional and unit tests for [[cli#graph]] — exporting the knowledge graph and diffing it against git history.

Tests in `tests/graph.test.ts`.

## Exports every section and edge as JSON

`lat graph --format json` produces a node for every document, section, and tag, and an edge for every `contains`, `wikilink`, and `code-ref` relationship, with document nodes carrying their `mode` and `status` frontmatter.

## Renders mermaid output

`lat graph --format mermaid` produces a `flowchart TD` diagram with labeled edges (`-->|`).

## Renders dot output

`lat graph --format dot` produces a Graphviz `digraph lat { ... }`.

## Rejects an unknown format

`lat graph --format yaml` (or any format outside json/mermaid/dot) exits non-zero.

## Untrusted heading survives every format

A section heading containing quotes does not break JSON, Mermaid, or Graphviz output in any of the three formats — quotes are escaped (`#quot;` in Mermaid) rather than terminating a label early.

## Reconstructing the graph at a git revision

`--at <rev>` rebuilds the graph as it existed at a past commit by reading each source file's blob at that revision, instead of the working tree.

### Differs from the working tree

Graphing `HEAD~2` on a repo that later deleted a section produces different JSON than graphing the working tree, and the old graph still contains the since-deleted section.

### --since names a removed section

`lat graph --since <rev>` reports sections added, removed, or changed between that revision and the working tree, naming a deleted section as "removed".

## graph-export unit tests

Low-level tests against `buildGraph`, `diffGraphs`, and the three formatters directly, without going through the CLI.

### diffGraphs reports added, removed, and changed sections

Diffing two in-memory graphs built from before/after markdown reports the removed section and the added section by id.

### Formatters succeed on a quoted, control-charred label

`formatGraphJson`, `formatGraphMermaid`, and `formatGraphDot` all complete without throwing on a graph whose section heading contains quotes and control characters, and the Mermaid output escapes the quotes.
