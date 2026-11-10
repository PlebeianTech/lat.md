---
lat:
  require-code-mention: true
---

# Usage Dashboard Agents

Tests in `tests/usage-dashboard-agents.test.tsx` for the Agents page of the usage dashboard: per-session comparison charts and a table of the five agents.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/aggregate-types.ts` and a fake `EventSource`. None asserts on elapsed time.

## Each signal compares agents per session

Four bar charts rank the agents on lat commands per session, search hit rate, bypass rate and net tokens saved per session. An agent with many sessions does not win on volume, since each value is a per-session figure or a share of searches or reads.

Net tokens saved is divided by the agent's sessions and labelled "correlation, not cause" with the method version. The table column shows the same per-session figure under a "per session" header, never the agent's total.

## Selecting an agent sets the agent filter and opens Overview

An agent row links to Overview with the agent filter set to that agent and every other filter kept. There is no agent detail view, so an agent detail path shows the same list.

## An agent with no sessions shows a no-sessions row

All five agents appear. An agent with no sessions, or missing from the summary, shows a row marked "no sessions in range" with zero sessions and unknown per-session measures.

## Ratios show without sessions

An agent with searches or reads but no session ids, such as the `unknown` agent, shows its known search hit rate and bypass rate in the table and the charts.

These are shares of searches and reads, not per-session figures. Only the per-session columns read "unknown" for it. A reason the summary gives for an unknown net tokens saved is listed even when the agent has no sessions.

## Unknown values are shown as unknown

A null signal reads "unknown", never 0. An unknown net tokens saved shows the reason the summary gave.

## Links keep the filter query string

Every link carries the current filters as a query string, with the agent filter replaced by the chosen agent.

## Loading, error and empty states

The page shows a loading line before the first data, an alert with the error message while keeping the last data, and a no-sessions message when no agent has a session, with the five agent rows still listed.
