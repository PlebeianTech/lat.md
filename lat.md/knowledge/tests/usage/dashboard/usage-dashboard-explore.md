---
lat:
  require-code-mention: true
---

# Usage Dashboard Explore

Tests in `tests/usage-dashboard-explore.test.tsx` for the Explore page of the usage dashboard: raw events with facet filters, group-by, paging and export.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/event-index.ts`, and a fake `EventSource`. None asserts on elapsed time.

## Selecting facet values filters the table and updates counts

Each facet field lists its top values with counts. Ticking a value keeps only the events with that value, the other facets recount over the remaining events, and the page says that the facet lists show the top 20 values.

Facet filters apply in the page, over all events of the current filters, because the raw endpoint takes no per-field filter.

## Group-by produces counts by the chosen field

Choosing a field in the group-by control replaces the event table with a table of counts per value, most frequent first, with unknown values counted as "unknown" and the top 20 values shown.

## Paging loads the next page without duplicates

The event table shows the newest page first. The load-more control follows the cursor and appends the next page. An event that appears in two pages is shown once.

## Export downloads the current filtered result as JSON lines

The export control reads every page of the current result through the data hook and downloads one JSON record per line, as the endpoint returned it, narrowed by the ticked facet values.

## The filtered view refreshes on usage changes

When a facet is ticked, group-by is on or events are selected by id, the page reloads its events after a usage-change message from the server. The old rows stay on screen until the new ones arrive.

## Stale rows are never shown under new filters

When the filters or the selected event ids change, the rows, counts and facets loaded for the old ones disappear at once and a loading note shows until the new events arrive.

## Ticking a facet keeps the sidebar mounted

Ticking the first facet value leaves the sidebar and the ticked checkbox in place while the page loads every event, so the checkbox keeps keyboard focus. The facet endpoint supplies the counts until the loaded events arrive.

## Selected events show exactly those events

An `event` query parameter, repeated or not, shows only those events through the `ids` parameter of the raw endpoint. A note says how many are selected and a control clears the selection.

## Unknown values are shown as unknown and no command text is shown

A null field reads "unknown". The table shows ids, counts, paths and section ids only: a stored command text is never rendered.

## A bypass read shows its path

A `bypass_read` session event shows the file it read in the section-or-path column, as a `tool_call` does, not "n/a".

## Links keep the filter query string

Session and section links carry the current filters as a query string, without the `event` selection.

## States show loading, errors and empty results

A failing request shows its message. A result with no events says so.
