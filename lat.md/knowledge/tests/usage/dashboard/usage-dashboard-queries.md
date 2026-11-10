---
lat:
  require-code-mention: true
---

# Usage Dashboard Queries

Tests in `tests/usage-dashboard-queries.test.tsx` for the Queries page of the usage dashboard: a sortable table of search queries and a query detail view.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/aggregate-types.ts`, and a fake `EventSource`. None asserts on elapsed time.

## The table shows every column and sorts by empty-result share

Each normalized query is one row with its searches, sessions, median results, empty-result share, followed share, median rank opened, reformulations and a daily sparkline.

The empty-result share header is a button that sorts the rows, and a query with an unknown share sorts last.

## The detail view shows returned sections, opened ranks and reformulations

The detail view of a query shows each section it returned, how often it was returned and opened, and the ranks at which agents opened it.

The ranks and the follow-up queries come from the facts on the query row, which the server computes. The view lists the follow-up queries with a count, and a sparkline of searches per day. It shows section ids and stored query strings only, never result snippets or section bodies.

## The detail view renders the facts the server sends

The detail view shows the opened ranks and reformulation targets of the query row as given, duplicates and a null query included, and requests no raw events.

## A section id named like an object property shows no inherited ranks

A returned section whose id is `__proto__`, `constructor` or `toString` renders. It shows the ranks the row holds under that id as an own key, or "none" when it holds none.

## Another query never shows the previous query's facts

Moving from one query's detail page to another shows only the new query's sections and reformulations. Each query's facts travel with its row, so the new query's facts show at once.

## Unknown values are shown as unknown

A null result count, empty-result share, followed share or median rank reads "unknown", never 0.

## Links keep the filter query string

Every link to another page or detail view carries the current filters as a query string: the query rows, the section links, the reformulation links and the way back to the list.

## Loading and error states

While nothing is loaded the page says so. An error shows its message and keeps the last data visible. With no queries under the filters the page says there are none. A query missing from the summary says so on its detail view.
