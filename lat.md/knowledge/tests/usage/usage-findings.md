---
lat:
  require-code-mention: true
---

# Usage Findings

Tests in `tests/usage-findings.test.ts` for the findings engine (`src/fork/usage/findings.ts`) and `GET /api/usage/findings`.

The engine tests feed fixture summaries and raw records straight to `computeFindings`. The route tests start a real `lat ui` server on a temporary project root with fake session sources. None asserts on elapsed time.

## Repeated empty searches group into one finding

Searches with no results and one normalized query form one `empty-search` finding. Case and spacing do not split it.

It counts the searches, the distinct sessions, the first and last time seen and one count per day. Searches with results or an unknown result count are not evidence.

## A bypassed file is a finding

Raw reads of one lat.md file by agents, taken from the bypass read events, form one `bypassed-file` finding per path.

## A never-read section is a finding

Each section of the graph snapshot with no reads in the range is a `never-read-section` finding. A missing snapshot or a failed `knowledge` extension gives no findings, because unknown is not unread.

## Findings carry counts, dates and capped evidence

Every finding has a stable id of kind and subject, a count, sessions affected, first and last seen, a daily series and at most 50 evidence event ids, newest first.

Evidence holds event ids only, never text.

## Findings are ranked by sessions then count

The list is ordered by sessions affected, then by count, then by id so equal findings keep a stable order.

## The closest section is suggested for an empty search

An empty-search finding names the section whose title shares the most words with the query, with its similarity. It names none when no title shares a word.

## Extra detectors plug in

A detector added to the exported `findingDetectors` list contributes its findings to the same ranked list.

The list is the registration point of `src/fork/usage/findings.ts`: a multi-line array under `// prettier-ignore`, one detector per line. A later issue adds its detector with one import and one line in that array, and nothing else in the file changes. A detector is `{ name, detect(input) }` where `input` holds the `/api/usage` summary and the raw records that match the same filters, newest first.

## A failing detector does not break the others

A detector that throws is reported under `errors` with its name. The findings of the other detectors still come back.

## Filters narrow the findings

`GET /api/usage/findings` takes the same `from`, `to`, `agent`, `session` and `issue` filters as `GET /api/usage` and returns only the findings of the matching events.

## Detectors can prepare asynchronously

A detector may define `prepare({ root })`. `findingsFor` awaits every `prepare` in parallel before `computeFindings` runs, so a detector can load async data into a cache that its synchronous `detect` reads.

## A failing prepare skips only its detector

A `prepare` that throws is reported under `errors` with the detector name, and that detector's `detect` is skipped for the call. The other detectors still run.

## Findings are memoized per data version

`findingsFor` caches its result in the aggregator's memo, keyed by the filters and the UTC day. Repeated and concurrent requests for the same filters run the detectors once.

Other filters run them again, and new data clears the cache. The live server also starts a new data version when the git head moves.
