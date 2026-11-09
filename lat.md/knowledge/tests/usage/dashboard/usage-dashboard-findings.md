---
lat:
  require-code-mention: true
---

# Usage Dashboard Findings

Tests in `tests/usage-dashboard-findings.test.tsx` for the Findings page of the usage dashboard: a table of grouped problems with count, sessions affected, first and last seen and a sparkline, and a detail view per finding.

They render the page in jsdom with `useUsageData` mocked to serve fixtures typed from `src/fork/usage/findings.ts`. None asserts on elapsed time.

## The list shows every finding kind with all columns

Each finding, whatever its kind, is one row with subject, kind, count, sessions, first seen, last seen and a sparkline of daily counts.

A kind the page does not know still renders with those columns. A missing first or last seen reads "unknown".

## The kind filter narrows the list

Choosing a kind above the table leaves only the findings of that kind, and choosing all kinds shows them again.

## Failed detectors are shown

Each detector named in `errors` appears in an alert with its message, with or without findings, so a failed detector is never read as "no problems". With no findings and no errors the page says there are none.

## The detail view explains the finding

The detail view of a finding states what its kind means and one sentence on what to do about it, and shows the closest-section suggestion when one exists. A kind the page does not know gets a generic explanation.

## Every utilization kind has guidance

`stale-hot-section`, `uncovered-hot-file` and `search-miss` each get a meaning and an action in the guide's wording, never the generic note.

## A search miss links its expected section

A `search-miss` detail shows its `expected_section_id` as a link to that section's Knowledge detail page, encoded, with the current filters kept.

## The detail view lists the evidence events

The detail view requests the evidence event ids from the raw events endpoint and lists each event with its id and time, a link to Explore, and links to the session and the bd issues it came from. It shows ids only, never transcript text.

## An unknown finding id says it no longer applies

A detail path whose id matches no finding under the current filters shows a message that the finding no longer applies under them, with a link back to the list.

## Links keep the filter query string

Links from the list to a detail view, and from a detail view to the list, Explore, sessions and issues, carry the current filter query string unchanged.

## Loading and error states

While the findings load, the page says so. When loading fails it shows the error message, and keeps the last findings visible if it has them.
