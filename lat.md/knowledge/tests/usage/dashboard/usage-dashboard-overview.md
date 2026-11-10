---
lat:
  require-code-mention: true
---

# Usage Dashboard Overview

Tests in `tests/usage-dashboard-overview.test.tsx` for the Overview page of the usage dashboard: four health signals, knowledge reach, net tokens saved, commands per day and the top five findings.

They render the page in jsdom with `useUsageData` mocked to serve fixtures typed from `src/fork/usage/aggregate-types.ts`, `src/fork/usage/missed-knowledge.ts`, `src/fork/usage/savings.ts` and `src/fork/usage/findings.ts`. None asserts on elapsed time.

## Each signal tile shows value, change and a sparkline

Adoption, search success, bypass rate and knowledge reach are tiles. Each shows its value for the range, the change against the previous range and a sparkline of the daily values.

The previous-range value comes from the summary's previous totals, and for knowledge reach from the missed-knowledge extension's previous range.

## An unknown signal says unknown with its reason

A signal that is null, or has no previous range to compare with, reads "unknown" with its reason and never 0. A missing or errored missed-knowledge extension makes the knowledge reach tile unknown with that reason.

## Net tokens saved shows range, cost, method version and the correlation label

The net tokens saved tile draws the low, point and high estimate beside the injected cost on one axis. It names the method version and is always labelled "correlation, not cause".

## Unknown net tokens saved shows its reason

When the savings extension is missing, holds an error, or has no range, the tile reads "unknown" with the reason and still carries the correlation label.

## Commands per day are stacked by command

The page draws one column per day, stacked by command, from the per-command daily series.

## The top five findings link to their detail pages

The top five findings are listed, each linking to its detail page with the id encoded. A sixth finding is not listed. Detectors that failed are named in an alert, so a missing finding is not read as a clean bill.

They rank by sessions and then by count, as the server and `lat usage gaps` rank them, so a finding seen in more sessions outranks one with more events.

## A stale hot section counts reads

A `stale-hot-section` finding's count is the section's reads, so its Overview label says `reads`, such as `(stale-hot-section, 400 reads)`. Every other kind says `events`, except `never-read-section`.

A `never-read-section` finding has no reads to count, so its label is only the kind, `(never-read-section)`.

## With no events the page shows how to enable tracking

When the summary totals count no events and no filter is set, the page shows `lat usage enable` in place of tiles and empty charts. A null signal with events present is not treated as no events.

When a filter is set, the page says "No events match the current filters." instead, since the project may already be tracked.

## Links keep the filter query string

Every link to another page or a detail view carries the current filter query string, in the same parameter order the shell writes.

## Loading and error states

The page shows a loading message before the first data, and an error message in an alert that keeps the last data visible.
