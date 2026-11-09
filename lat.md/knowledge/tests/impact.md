---
lat:
  require-code-mention: true
---
# Impact

Functional tests for [[cli#impact]] — the multi-hop query that lists which sections are affected when one section changes, run against this repository's own knowledge graph.

Tests in `tests/impact.test.ts`.

## Lists depth 1 and depth 2 with a tail summary

`lat impact cli#CLI#gen` prints each section that reaches the target within two hops as an id followed by `file:line`, grouped by depth, and ends with a single line counting the sections further out.

The fixture is a hub: it has one direct reference and dozens of sections reachable behind it, so the default depth must hide most of them.

## Lists the tail on request

`--depth 5` prints the sections the default hid, a larger `--depth` keeps going, and the tail line disappears once nothing lies beyond the depth.

## Prints a clear empty result

A section nothing refers to produces one line saying no section depends on it, not an empty body and not an error.

## Resolves short and canonical ids alike

`cli#gen`, `cli#CLI#gen` and `lat.md/knowledge/cli#CLI#gen` produce byte-identical output, and each listed result carries the `startLine` of its section.

## Stays under the cost of lat section

The default output for every section in the repository is smaller than the 4,119 bytes `lat section` costs for [[cli#search#Backend selection]], and the worst case `cli#CLI#gen` is asserted explicitly.

Without this bound a change that prints leading paragraphs ships unnoticed, and the command stops being cheaper than reading the section.

## Rejects an unknown section

A query matching no section exits with an error naming the query, so an agent does not mistake it for an empty impact.

## Walks through code nodes

A section that depends on another only through a code node (code that implements the target, and a section that links to that code) is still reported, and the code node itself is never listed.

## Lists the specs that cover a symbol

`lat impact <file>#<symbol> --specs` prints the test-spec sections that reach the symbol through the `@lat` chain, each as an id and `file:line`.

It never prints a code node or a section outside a test-spec document. The fixture `src/cli/comment-reminder.ts#judgeWrittenComments` is referenced by specs in two documents, and both must appear.

## Prints a clear empty result for an uncovered symbol

A symbol that no test spec reaches produces one line saying no test spec covers it, not an empty body. A symbol that does not exist in its file is an error that names the query.

## Stays under the cost of lat section for every symbol

The default `--specs` output for every `file#symbol` target in this repository's graph is smaller than the 4,119 bytes `lat section` costs for [[cli#search#Backend selection]]. Like [[impact#Impact#Stays under the cost of lat section]], this keeps the coverage query cheaper than reading the specs it names.

## Counts an @lat comment in or directly above the symbol

A symbol is covered by the spec an `// @lat: [[section]]` comment points at when the comment sits inside the symbol's line range or in the comment block directly above its declaration, as this repository's convention places it.

The block is the consecutive comment lines ending on the line before the declaration. A blank or code line between the comment and the declaration ends it, so that comment does not count.

## Lists a section nothing refers to

`lat impact --unreferenced` prints every section that no wikilink and no `@lat` comment points at, each as an id and `file:line`. Tests for it are in `tests/impact-unreferenced.test.ts`.

## Omits a section that has a referrer

A section with one inbound wikilink is not listed, so the output holds only sections nothing can reach.

## Lists a root index document like any other

A document no section links to is listed with its sections. The command makes no exception for a root, so the reader decides which unreferenced sections are legitimate roots.

## Bounds the unreferenced list and prints all on request

The default `--unreferenced` output for this repository is smaller than the 4,119 bytes `lat section` costs for [[cli#search#Backend selection]], and ends with one line counting the sections it left out. `--all` prints every one.
