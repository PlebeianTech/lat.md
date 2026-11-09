---
lat:
  require-code-mention: true
---

# Usage Dashboard Data Hook

Tests in `tests/usage-dashboard-data-hook.test.tsx` for `useUsageData` and `fetchAllUsageEvents` in `view/src/usage/use-usage-data.ts`, which every dashboard page reads through.

They render hooks in jsdom with a fake `fetch` and a fake `EventSource` that the test drives by hand. None asserts on elapsed time: each test emits an event or resolves a request, then awaits the result.

## The request carries the filters and extra parameters

The hook fetches the path with the URL's shared filters and the caller's extra parameters in the query string.

## A filter change refetches

Changing a filter in the URL sends a new request with the new filters.

## Previous data stays while refetching

While a refetch is in flight the hook keeps the last data and reports `loading`, so pages do not flash empty.

## A stale response never overwrites newer data

A filter change aborts the request for the old filters. If that request still answers after the new one, its data is ignored.

## A change during a request lets it finish

A `usage-change` that arrives while a request is in flight does not abort it. The hook marks the data stale, shows the response when it arrives, and then refetches once, however many changes arrived meanwhile.

## A change event refetches once

One `usage-change` event causes exactly one new request, however many components use the hook, and all of them get the new data.

## A failed refresh keeps the last good data

A `usage-error` event sets `error` to the server message and keeps `data`. The next successful fetch clears it. A failed request sets `error` the same way, with the message the server sent.

## Components share one stream

Any number of hook instances open a single event stream. It closes when the last one unmounts.

## Hidden tabs close the stream

When the tab becomes hidden the stream closes. When it becomes visible again the hook opens one new stream and refetches once.

## Unmounting aborts the request

A request still in flight when the component unmounts is aborted and sets no state.

## All raw events are fetched across pages

`fetchAllUsageEvents` follows `next_cursor` through three pages, passes the filters on each request, and returns every record once, newest first, without duplicates.
