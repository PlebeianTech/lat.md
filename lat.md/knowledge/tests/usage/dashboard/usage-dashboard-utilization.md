---
lat:
  require-code-mention: true
---

# Usage Dashboard Utilization

Tests in `tests/usage-dashboard-utilization.test.tsx` for the Utilization page of the usage dashboard: when and why agents did not gain knowledge through lat, by bd issue type.

They render the page in jsdom with `useUsageData` mocked to serve fixtures typed from `src/fork/usage/missed-knowledge.ts`, `src/fork/usage/section-scorecard.ts`, `src/fork/usage/miss-consequences.ts` and `src/fork/usage/findings.ts`. None asserts on elapsed time.

## Reach renders per issue type

A bar list shows the knowledge reach of each issue type, including the `untyped` and `unknown` buckets. A type whose reach is null reads "unknown" with its reason, never zero.

## Outcomes stack per issue type

A stacked chart shows the six outcomes per issue type, with the issue type as the category axis.

## Findings link to their detail

Top undocumented files and top search misses link to their finding, keeping the filter query string.

A search miss also links to its expected section on the Knowledge page. Other finding kinds do not appear, and a failed detector is named.

## The session table links to session detail

Each session row lists the issue types the session worked on, so a shared session shows several. A session whose reach is unknown shows the reason. Session ids link to the session detail with the filters kept.

## The page says outcomes are inferred

The page states that outcomes are inferred from behaviour and shows the method version from the data.

## The scorecard sorts by misses

The Sections to fix first table puts the section with the most misses first and shows its main miss and suggested fix. Rows link to the section on the Knowledge page.

## The cost comparison shows both groups

The Did misses cost anything block compares sessions that reached everything with sessions that had a miss.

It shows each group's sample size, the left-out counts, unknown values with their reasons, the method version and the label "correlation, not cause".

## Missing data shows unknown

A missing extension, or one that holds an error, shows "unknown" with its reason, never zero or blank.
