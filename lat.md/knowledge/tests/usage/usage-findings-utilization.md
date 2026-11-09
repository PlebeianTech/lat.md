---
lat:
  require-code-mention: true
---

# Usage Findings Utilization

Tests in `tests/usage-findings-utilization.test.ts` for the `utilization` detector (`src/fork/usage/findings-utilization.ts`), which turns the missed-knowledge analysis into `uncovered-hot-file` and `search-miss` findings.

Each test hands `computeFindings` a summary whose `missed_knowledge` extension is built by hand, plus raw records for the evidence. None asserts on elapsed time.

## A file edited in three sessions without coverage is reported

An undocumented file edited in 3 or more sessions yields an `uncovered-hot-file` finding. A file edited in only two sessions yields none.

The subject is the file path. An edit path matches after its leading `./` and the project root's git prefix, read once per root by `git rev-parse --show-prefix`, are removed. A git failure means an empty prefix, never an error. The evidence is the ids of the edit events on that file, never transcript text.

## A search that missed a needed section is reported

A normalized query on a `searched-not-found` outcome yields a `search-miss` finding. Its `expected_section_id` is the section that was needed.

The subject is the query and the evidence is the ids of that query's search events in the sessions that missed, made before that session's first edit. A query that missed two sections yields two findings with distinct ids. Other outcomes yield none.

## Utilization findings rank and group like other findings

Both kinds carry the shared finding shape and a daily series over the summary days. They rank with the other detectors by sessions, then count, then id.

## A failed analysis is an error, an absent one is empty

When `missed_knowledge` is `{ error }`, the detector throws. `computeFindings` then reports the failure under the detector name instead of saying nothing is wrong.

When the extension is absent, as in a run with no contributions, the detector returns no findings and no error.
