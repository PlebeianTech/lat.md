---
lat:
  require-code-mention: true
---

# Fork Graph Edge Roles

Tests in [[tests/fork-graph-edge-roles.test.ts]] for [[src/graph-export.ts#buildGraph]], which assigns optional [[src/graph-export.ts#GraphEdgeRole]] values to [[src/graph-export.ts#GraphEdge]] records.

## Contains hierarchy edges omit role

[[src/graph-export.ts#buildGraph]] leaves `role` undefined on `contains` edges between documents, parent sections, and child sections.

## Tag edges omit role

[[src/graph-export.ts#buildGraph]] leaves `role` undefined on `tag` edges linking documents to frontmatter tag nodes.

## Contains and tag edges omit role in json

[[src/graph-export.ts#formatGraphJson]] omits the `role` key on serialized `contains` and `tag` edges.

## Wikilink targeting test spec frontmatter receives test spec ref

[[src/graph-export.ts#buildGraph]] assigns `role: 'test-spec-ref'` to `wikilink` edges targeting sections in documents with `require-code-mention: true`.

## Wikilink targeting test directory doc receives test spec ref

[[src/graph-export.ts#buildGraph]] assigns `role: 'test-spec-ref'` to `wikilink` edges targeting sections in documents under `lat.md/tests/`.

## Wikilink targeting knowledge tests doc receives test spec ref

[[src/graph-export.ts#buildGraph]] assigns `role: 'test-spec-ref'` to `wikilink` edges targeting sections in documents under `lat.md/knowledge/tests/`.

## Wikilink targeting standard document receives section ref

[[src/graph-export.ts#buildGraph]] assigns `role: 'section-ref'` to `wikilink` edges targeting sections in non-test `lat.md/` documents.

## Wikilink targeting source symbol receives symbol ref

[[src/graph-export.ts#buildGraph]] assigns `role: 'symbol-ref'` to `wikilink` edges that resolve to `code:` symbol or file nodes.

## Wikilink targeting unresolved code target receives symbol ref

[[src/graph-export.ts#buildGraph]] assigns `role: 'symbol-ref'` to `wikilink` edges whose targets do not match a `lat.md/` section id and resolve to `code:` nodes.

## Code ref from test file receives verifies role

[[src/graph-export.ts#buildGraph]] assigns `role: 'verifies'` to `code-ref` edges when [[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] classifies a top-level test directory caller as `'test'`.

## Code ref from nested test file receives verifies role

[[src/graph-export.ts#buildGraph]] assigns `role: 'verifies'` to `code-ref` edges originating from nested test directories such as `src/tests/`.

## Code ref from test suffix file receives verifies role

[[src/graph-export.ts#buildGraph]] assigns `role: 'verifies'` to `code-ref` edges originating from `.test.<ext>` or `.spec.<ext>` files.

## Code ref targeting test spec receives verifies role

[[src/graph-export.ts#buildGraph]] assigns `role: 'verifies'` to `code-ref` edges in production files that target sections in test-spec documents.

## Code ref from test file targeting test spec receives verifies role

[[src/graph-export.ts#buildGraph]] assigns `role: 'verifies'` when a test file's `@lat:` comment targets a section in a test-spec document.

## Code ref from production code receives implements role

[[src/graph-export.ts#buildGraph]] assigns `role: 'implements'` to `code-ref` edges in production source files targeting non-test sections.

## Baseline graph edge types remain preserved

[[src/graph-export.ts#buildGraph]] preserves the baseline `type` values (`contains`, `wikilink`, `code-ref`, `tag`) on every [[src/graph-export.ts#GraphEdge]].

## JSON serialization includes role on semantic edges

[[src/graph-export.ts#formatGraphJson]] serializes the string `role` field on `wikilink` and `code-ref` edges.

## Mermaid formatter preserves edge type syntax

[[src/graph-export.ts#formatGraphMermaid]] labels flowchart edges with `edge.type` without syntax changes from `edge.role`.

## Dot formatter preserves edge type syntax

[[src/graph-export.ts#formatGraphDot]] labels Graphviz `digraph` edges with `edge.type` without syntax changes from `edge.role`.

## CLI graph export outputs classified edge roles

Running `lat graph --format json` ([[src/cli/graph.ts#graphCommand]]) emits classified `role` fields on exported `wikilink` and `code-ref` edges.

## Graph diffs remain unaffected by edge roles

[[src/graph-export.ts#diffGraphs]] diffs section node ids and `bodyHash` values independently of `edge.role` annotations.

## Edge role literals exclude em dashes

All [[src/graph-export.ts#GraphEdgeRole]] literals (`section-ref`, `symbol-ref`, `test-spec-ref`, `implements`, `verifies`) contain zero Unicode em dashes and zero en dashes.
