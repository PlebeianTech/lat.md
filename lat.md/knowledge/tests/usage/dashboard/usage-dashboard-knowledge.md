---
lat:
  require-code-mention: true
---

# Usage Dashboard Knowledge

Tests in `tests/usage-dashboard-knowledge.test.tsx` for the Knowledge page of the usage dashboard: the most-read sections, the never-read sections, a knowledge map of the lat.md documents, and the section detail view.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/aggregate-types.ts`, `src/fork/usage/graph-snapshot.ts` and `src/fork/usage/section-scorecard.ts`, and a fake `EventSource`. None asserts on elapsed time.

## The top 20 list and the never-read count and list render

The page ranks the 20 most-read sections in a bar list, and shows the count of never-read sections, which expands into their list.

A twenty-first section does not appear in the bar list. The never-read count comes from the knowledge extension of the summary, and each never-read section links to its detail view.

## The map sizes blocks by bytes and shades them by reads

The knowledge map draws one block per document, with an area proportional to the document's bytes and a fill on the sequential ramp by its reads.

A large document with no reads gets the palest fill, so it stands out as content that costs upkeep but is rarely read. The map has an accessible name and a hidden value table.

## The detail view shows reads over time, leading queries and reading issues

The detail view of a section shows its reads per day, the queries that led to a read, and the issues whose sessions read it.

It shows section ids, query strings and issue ids only, never section bodies.

## The section detail shows the reach series with a marker at each content change

The detail view shows the section's reach per day from the section scorecard, and lists one marker for each git head where the section's content changed.

A section renamed from another id shows the old id.

## Missing or failed extensions show unknown with a reason

When the knowledge or scorecard extension is missing or holds an error, the page says "unknown" with the reason, never an empty list or a zero.

## Links keep the filter query string

Every link to another page or detail view carries the current filters as a query string: the section links, the never-read links, the query links and the issue links.

## A never-read section opens a detail view from the scorecard alone

A section nobody read has no section row, so its detail view says it has no reads and still shows the reach series and content changes from the scorecard.

## Unavailable git heads are shown as a note

When the knowledge or scorecard extension lists git heads that could not be snapshotted, the page names them with their reasons, so partial data is not read as complete.
