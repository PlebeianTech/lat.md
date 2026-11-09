---
lat:
  require-code-mention: true
---

# Usage Dashboard Issues

Tests in `tests/usage-dashboard-issues.test.tsx` for the Issues page of the usage dashboard: a tree of bd issues with own and rolled-up totals, an unattributed row above it, and an issue detail view.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/aggregate-types.ts`, and a fake `EventSource`. None asserts on elapsed time.

## The tree nests epics, sub-epics and leaves with own and rolled-up totals

Each issue is one row with its type, status and, for both its own events and its events plus its descendants, the lat commands, search success, bypass reads, net tokens saved and sessions.

A child issue sits under its bd parent, whatever its id, and shows once the parent is expanded. An issue whose parent has no row is a top-level row. A self-parent or a parent cycle never crashes the page: one member of the cycle is shown at top level and the others nest under it, so every row stays visible. The parent's rolled-up commands differ from its own. The table has no footer and no grand total: issues share events, so a sum over rows would count them twice.

## The unattributed row shows its totals from the summary

Above the tree one row reports the activity matched to no issue, taken from the summary's unattributed row and never computed by subtracting issue rows.

## The detail view shows signals, children and sessions

The detail view of an issue shows the four health signals over the issue and its descendants, links to its child issues and links to the sessions that worked on it or on a descendant.

## Unknown values are shown as unknown

A net tokens saved of null reads "unknown", never 0, and the detail view gives its reason.

Every place that shows net tokens saved (the table note, the unattributed row and the detail view) carries the label "correlation, not cause", with the savings method version when the summary has one. Per-issue values are point values, because there is no per-issue range.

## Links keep the filter query string

Every link to another page or detail view carries the current filters as a query string: the issue rows, the child and session links and the way back to the list.

## Loading and error states

While nothing is loaded the page says so. An error shows its message and keeps the last data visible. With no issues under the filters the page says there are none.
