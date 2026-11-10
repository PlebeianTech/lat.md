---
lat:
  require-code-mention: true
---

# Usage Live Raw Events

Tests in `tests/usage-live-raw-events.test.ts` for `GET /api/usage/raw` (`src/fork/usage/live-raw-events.ts`) and the in-memory index behind it (`src/fork/usage/event-index.ts`).

They start a real `lat ui` server on a temporary project root, write fixture usage logs, and replace the session sources and the bd watcher with fakes. None reads a real agent store or the live bd database, and none asserts on elapsed time.

## Records match the shared filters

`from`, `to`, `agent`, `session` and `issue` narrow the records as they narrow `/api/usage`. An issue filter includes its descendants.

Usage events and session events both come back, each with its attributed bd issue ids and attribution method.

## Records come back newest first with a cursor

Records are ordered newest first, ties broken by id. `next_cursor` continues after the last record: following it across pages returns every record once, with no duplicate and no gap, and is null on the last page.

## A session event without a readable time is dropped

A session event whose `ts` `Date.parse` cannot read, such as the empty string a reader emits when the store has no time, is left out of the index.

Ingest drops it before it enters the state the index reads. The other events still sort newest first and page to the end with no error.

## Turning usage off empties the index

When `.lat/usage/` is renamed away while the server runs, the next request lists no records. When the directory comes back, the same records are listed again.

## The page is capped at 200 records

The default and the maximum `limit` are 200. A larger limit is clamped to 200. A limit that is not a positive integer is rejected.

## Ids load evidence

`ids` takes up to 50 comma-separated event ids and returns only the matching records, through the same filters. More than 50 ids are rejected.

## Facets count a field over the filtered set

`facet=<field>` returns the top 20 values with counts for the filtered records, not the records. The allowed fields and the cap live in [[src/fork/usage/raw-facets.ts]], which the dashboard imports too.

It also gives the number of records whose value is null with no recorded reason (`missing`), the nulls of a section id or error class that lat recorded a reason for (`unknown`), and the records of a kind that has no such field (`lacking`). The fields are command, agent, caller, surface, session_id, section_id, error_class and exit_code. Any other field, including `issue`, is rejected.

## Field filters and the query filter narrow records and facets

`where.<field>=<value>` keeps records whose field, as text, is that value. `query=<text>` keeps usage events whose search query is exactly that text.

Repeat `where.<field>` for more values of one field; fields combine. Both apply to pages and facets, with `ids` and the shared filters. An unknown `where` field is rejected.

A page also carries `total`: the number of records that match all filters, the same on every page of one result.

A session event has none of the usage-only fields, so it never matches a value filter.

## Records hold pointers, not transcript text

A session tool call carries its `source` pointer and no shell command. The index lives in memory and writes no file.

## One bd watcher serves the summary and the index

A server makes one bd watcher for its project root. The summary route and the raw events index both read it, so a refresh runs the bd commands once.

The test requests the summary, a page and a facet of one root, and expects the watcher factory to run once and that watcher to be refreshed.

## Findings share the watcher of the root

`GET /api/usage/findings` reads the raw event index through the watcher of the root, so a findings request that arrives first makes no second watcher.

The test requests findings, then a page, and expects the watcher factory to run once for the root.

## A restarted server hands the index its new watcher

The index outlives the live server that fed it. When the server stops and starts again, the next raw request reads the new server's watcher.

The test stops the live server of a root, requests a page again and expects the stopped watcher to be left alone and the new one to be refreshed.

## Raw and findings requests share the discovery of a change

The raw events and findings routes find session files through the same discovery as the change check and the aggregator.

After one change, ten requests to `/api/usage/raw` and one to `/api/usage/findings`, sent together, call `discover` once on each source, not once per request. So does a findings request that is the first to read the index.

## A restarted server hands the index its new sources

The index outlives the live server, and the live server keeps the discovery it shares. When the server stops and starts again, the next raw request lists the session files the new server found, not the ones the stopped server remembered.

The test stops the live server of a root, adds a session file, requests a page again and expects the events of the new file in it.

## An index without a live server discovers on the raw sources

An index read with no live server, as the MCP tool reads it, keeps the raw session sources and calls `discover` on them for every read.

The test reads a page twice with no live server and expects two `discover` calls on the source.
