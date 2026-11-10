---
lat:
  require-code-mention: true
---

# Usage Dashboard Data Hook

Tests in `tests/usage-dashboard-data-hook.test.tsx` for `useUsageData` and `fetchAllUsageEvents` in `view/src/usage/use-usage-data.ts`, which every dashboard page reads through.

They render hooks in jsdom with a fake `fetch` and a fake `EventSource` that the test drives by hand. None waits on real time: each test emits an event or resolves a request, then awaits the result. The retry tests run the pending timers with fake timers.

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

Any number of hook instances open a single event stream. It closes a microtask after the last one unmounts.

## A page change keeps the stream

Moving between dashboard pages keeps the one open stream, so the server keeps its live caches. A page change unmounts every hook and subscribes the next page's hooks in the same commit, before the deferred close runs.

## Hidden tabs close the stream

When the tab becomes hidden the stream closes. When it becomes visible again the hook opens one new stream and refetches once, on that stream's first `open`.

## A page opened hidden refetches when shown

A dashboard opened in a hidden tab fetches once and opens no stream. When the tab becomes visible, the first `open` of the new stream refetches once.

The server never sends the changes made while the tab is hidden. A page opened in a visible tab does not refetch on its first `open`.

## A browser reconnect refetches

When the browser reopens the stream on its own after an `error`, the hook refetches once, because changes made while the stream was down were never sent. The first `open` does not refetch.

## A closed stream is reopened

When a reconnect fails and the stream is `CLOSED`, the hook drops it and opens a new stream after a short delay. It refetches once, when the new stream's first `open` arrives. An `error` from the old, dropped stream is ignored.

## A retry refetches only once it connects

While the server is down, each retry stream fails before `open`, and no retry refetches. The first `open` after the retries sends one refetch, so the stream is registered before the data is read again.

## Unmounting aborts the request

A request still in flight when the component unmounts is aborted and sets no state.

## All raw events are fetched across pages

`fetchAllUsageEvents` follows `next_cursor` through three pages, passes the filters on each request, and returns every record once, newest first, without duplicates.
