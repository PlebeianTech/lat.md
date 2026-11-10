---
lat:
  require-code-mention: true
---

# Usage Dashboard Explore

Tests in `tests/usage-dashboard-explore.test.tsx` for the Explore page of the usage dashboard: raw events with facet filters, group-by, paging and export.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/event-index.ts`, and a fake `EventSource`. None asserts on elapsed time.

## Selecting facet values filters the table and updates counts

Each facet field lists its top values with counts. Ticking a value keeps only the events with that value, the other facets recount over the remaining events, and the page says that the facet lists show the top 20 values.

The ticked values go to the raw endpoint as `where.<field>` parameters, so the page never holds more than the pages it shows.

## Facets and group-by are filtered by the server

A ticked value is sent as a repeated `where.<field>` parameter. Each facet request leaves out its own field so that field keeps listing its other values, and group-by sends every ticked value. No request follows a cursor for a facet or a group.

## Group-by produces counts by the chosen field

Choosing a field in the group-by control replaces the event table with a table of counts per value, most frequent first, with unknown values counted as "unknown" (a null error class as "none") and the top 20 values shown.

## Paging loads the next page without duplicates

The event table shows the newest page first. The load-more control follows the cursor and appends the next page. An event that appears in two pages is shown once.

## Load more stays mounted while the next page loads

After the first click on the load-more control, it stays in the page, disabled, while the older page loads, so a keyboard user keeps focus on it.

When the page arrives, the control follows the new cursor, and it goes away when there is none. It stays away while a live change refetches the last page.

## Export downloads the current filtered result as JSON lines

The export control reads every page of the current result from the endpoint and downloads one JSON record per line, as the endpoint returned it, narrowed by the ticked facet values, which the endpoint applies.

## The filtered view refreshes on usage changes

The event table, the facets and the group-by table refetch after a usage-change message from the server. The old rows stay on screen until the new ones arrive.

## A live change after load more shows new events and keeps older pages

After Load more, a usage-change refetches the first page and merges it: new events show at the top and older pages stay. Only the first page's range drops rows that stopped matching.

If new events fill more than a page, the list restarts from the first page.

## The event count comes from the server total

Above the event table the page says how many events match, "N events", from the `total` of the page response. It counts all matches under the ticked facets and filters, not the rows loaded so far.

## Stale rows are never shown under new filters

When the filters, the ticked facet values or the selected event ids change, the rows loaded for the old ones disappear at once and a loading note shows until the new events arrive.

## Ticking a facet keeps the sidebar mounted

Ticking a facet value leaves the sidebar and the ticked checkbox in place while the page loads the filtered events, so the checkbox keeps keyboard focus.

## Selected events show exactly those events

An `event` query parameter, repeated or not, shows only those events through the `ids` parameter of the raw endpoint, at most 50 of them. A note says how many are selected and a control clears the selection.

## Unknown values are shown as unknown and no command text is shown

A null field reads "unknown". The table shows ids, counts, paths and section ids only: a stored command text is never rendered.

A null error class or section id reads "unknown" only when the event records a reason for it. With no reason the field does not apply, such as the error class of a success or the section of a `lat search`, and it reads "—". Its facet and group-by bucket is labelled "none", and nulls with a reason get their own "unknown" bucket, counted by the endpoint.

## A bypass read shows its path

A `bypass_read` session event shows the file it read in the section-or-path column, as a `tool_call` does, not "n/a".

## Links keep the filter query string

Session and section links carry the current filters as a query string, without the `event` selection.

## States show loading, errors and empty results

A failing request shows its message. A result with no events says so.
