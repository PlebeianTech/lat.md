---
lat:
  require-code-mention: true
---

# Usage Section Scorecard

Tests in `tests/usage-section-scorecard.test.ts` for `src/fork/usage/section-scorecard.ts`.

Most tests hand the pure builder fixture outcome records and graph snapshots, so no git repository is involved. The wiring tests run the aggregator over a temporary git repository with a fake session reader and cached snapshots, the way the missed-knowledge tests do.

The result lands in `extensions.section_scorecard`. It rolls up the outcome records of `extensions.missed_knowledge` per section, so the same inferred-not-intended caveat applies. Section ids are shown and no transcript text.

## Counts and reach are per section

Each section that was expected in the range gets a row with the times it was expected, the times it was reached and a count per outcome. Reach is reached over expected.

## The main miss is the most frequent outcome other than reached

The main miss is the outcome with the highest count among the outcomes other than reached. A tie goes to the outcome that comes first in the outcome order: reached, read-late, bypassed, found-not-opened, searched-not-found, never-consulted.

## A section that was only reached has no main miss

A section whose outcomes are all reached has no main miss and no suggested fix, both null.

## The suggested fix follows the main miss

Each miss outcome maps to one fixed suggestion: reword the title (searched-not-found), improve the leading paragraph (found-not-opened), add @lat links (never-consulted), split the file (bypassed), review agent instructions (read-late).

## Reach is a daily series by session start

Every day of the range has a point with the sections expected and reached that day, bucketed by the start date of the session. A day with nothing expected has reach null, never 0.

## A change marker sits where the content hash changed

A marker names the git head at which the hash of a section differs from its hash at the previous head with a snapshot. An unchanged hash gives no marker, and the first head a section appears at gives none.

## Markers are ordered and dated by the earliest event at each head

Git heads carry no time. Heads are ordered by the earliest event seen at each, and a marker takes the date of that event.

## A renamed section is a new row and the old row ends

A section is renamed when a new id appears in the same file with the same body hash as an old id that is gone at that head. The new row carries renamed_from, and the old row ends at the last head where the old id exists.

## A head without a snapshot is reported

A head whose snapshot cannot be built is listed with its reason and takes no part in the markers or renames.

## The scorecard uses the missed-knowledge records through the aggregator

Run through the aggregator over a git repository, the scorecard counts the outcomes of the missed-knowledge analysis and marks the head at which the hash changed.

## A failing missed-knowledge analysis is an error, not zeros

When the missed-knowledge prepare or compute throws, the scorecard is reported as an error under its key.
