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

## The page is capped at 200 records

The default and the maximum `limit` are 200. A larger limit is clamped to 200. A limit that is not a positive integer is rejected.

## Ids load evidence

`ids` takes up to 50 comma-separated event ids and returns only the matching records, through the same filters. More than 50 ids are rejected.

## Facets count a field over the filtered set

`facet=<field>` returns the top 20 values with counts for the filtered records, not the records. The allowed fields and the cap live in [[src/fork/usage/raw-facets.ts]], which the dashboard imports too.

It also gives the number of records whose value is null. The fields are command, agent, caller, surface, session_id, section_id, error_class and exit_code. Any other field, including `issue`, is rejected.

## Records hold pointers, not transcript text

A session tool call carries its `source` pointer and no shell command. The index lives in memory and writes no file.
