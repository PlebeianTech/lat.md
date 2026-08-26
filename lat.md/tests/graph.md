---
lat:
  require-code-mention: true
---
# Graph

Functional and unit tests for [[cli#graph]] — exporting the knowledge graph and diffing it against git history.

Tests in `tests/graph.test.ts`.

## Exports every section and edge as JSON

`lat graph --format json` produces a node for every document, section, and tag, and an edge for every `contains`, `wikilink`, and `code-ref` relationship, with document nodes carrying their `mode` and `status` frontmatter.

## Every edge endpoint is a real node

Every `from` and `to` in the graph names a node that exists, every section and document node carries a `file`, and the fixture's wikilink and code-ref land on the canonically-cased section ids rather than lowercased look-alikes.

A ref resolves through the slug index, which lowercases each heading, while sections are parsed under the heading's original case. Resolving the returned id through a lowercase-keyed canonical map is what keeps a ref from minting a second, file-less, `contains`-less copy of a section it merely points at.

Asserting only that some wikilink edge exists cannot see this: the edge exists either way, it just terminates on a node nothing parsed.

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

`lat graph --since <rev>` reports sections added, removed, or changed between that revision and the working tree, listing the deleted section under `removed` and the since-added one under `added`, with each bucket's count matching its entries.

### --since names a reworded section

Rewriting a section's prose while leaving every heading alone is reported under `changed`, with `added` and `removed` both empty.

### Non-ASCII paths survive git ls-tree

A document at a path containing non-ASCII bytes appears in a revision graph, and `--since` against an unmodified tree reports nothing added, removed, or changed.

Git's default `core.quotePath` C-quotes such a path, producing a name that ends in `.md"` rather than `.md`. A line-based `.md` filter drops it silently, so every section in it looks newly added. `git ls-tree -z` sidesteps the quoting entirely and additionally survives a path containing a newline, which no line-based parse can.

### Reads a document larger than the default pipe buffer

A committed document over 1 MB is read back without `git show` failing with `ENOBUFS` from `execFile`'s 1 MB default `maxBuffer`.

## graph-export unit tests

Low-level tests against `buildGraph`, `diffGraphs`, and the three formatters directly, without going through the CLI.

### diffGraphs reports added and removed sections

Diffing two in-memory graphs built from before/after markdown reports exactly the removed section id and exactly the added section id, and reports nothing as changed.

### diffGraphs reports a section whose prose changed

Rewriting a section's body under an unchanged heading is reported as `changed`.

A section node's id is its full heading chain and its label is the last heading in that chain, so equal ids imply equal labels — comparing labels can never detect an edit. Each node therefore carries a `bodyHash` over its own prose, and that is what the diff compares.

The hash covers the lines between a section's heading and the next heading of any level, so a child's edit is attributed to the child, not to its parent. `hashReviewedBody` is deliberately not reused: it strips a leading `---` block as frontmatter, which inside a section body is a pair of thematic breaks whose content would drop out of the hash.

### diffGraphs ignores whitespace-only edits

Adding trailing spaces to a section's lines, or a blank line at the end, is not reported as a change, because trailing whitespace is invisible in a diff.

### Formatters succeed on a quoted, control-charred label

`formatGraphJson`, `formatGraphMermaid`, and `formatGraphDot` all complete without throwing on a graph whose section heading contains quotes and control characters, and the Mermaid output escapes the quotes.
