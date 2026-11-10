---
lat:
  require-code-mention: true
---

# Usage Dashboard Shell

Tests in `tests/usage-dashboard-shell.test.tsx` for the dashboard shell in `view/src/usage/`: the route table, the left navigation, the global filter bar and the stub pages and data hook that later issues replace.

They render the app in jsdom with a `fetch` that never resolves and a fake `EventSource`, so pages that use the real data hook render. None asserts on elapsed time.

## Every navigation entry routes to its page

Each of the nine navigation entries, Overview, Findings, Sessions, Issues, Knowledge, Queries, Agents, Utilization and Explore, shows its own page when clicked, and the address bar holds that page's path under `/_usage`.

## Detail paths route with their id

A path such as `/_usage/sessions/abc` shows the Sessions page with the id `abc`. A knowledge id holding `#` and `/` round-trips through the URL encoded. A path under no page shows a not-found message.

## Changing a filter updates the URL and the filter state

Editing a filter field writes its parameter (`from`, `to`, `agent`, `session` or `issue`) to the query string and exposes it through `useUsageFilters` to every page. Clearing a field removes it.

## Text filters apply on Enter or blur

Typing in the Bd issue or Session field shows the text but sends no request and leaves the URL alone. Enter or leaving the field applies it, and exactly one summary request follows.

## Text filters follow the URL

When the URL value of the Bd issue or Session filter changes, as with browser Back, the field shows the new value.

## Date and agent controls apply at once

Changing the From, To or Agent control refetches the summary at once, without Enter or blur.

## Loading a URL with filters restores them

A page opened on a URL carrying filter parameters shows those values in the filter bar and exposes them through `useUsageFilters`.

## Navigation keeps the filters

Following a navigation entry keeps the filter parameters in the query string. It carries the filters only: a page's own parameter, such as Explore's `event=`, is not put on the navigation links.

## Changing a filter keeps page parameters

`setFilters` changes only the five filter names in the query string. A page parameter, such as Explore's `event=` selection, stays: at `/_usage/explore?agent=claude&event=e1&event=e2`, setting the agent to `codex` keeps both `event` parameters.

## Filters serialize to search parameters

`filtersToSearchParams` writes only the filters that are set, under the parameter names the endpoints read.

## A page using the data hook starts out loading

With `fetch` never resolving and a fake `EventSource`, a component calling `useUsageData` first renders with loading set and no data or error.

## The Vite build declares both entries

`forkViewInputs` returns the upstream `index.html` and the dashboard `usage.html`, so the build emits both.

## A malformed detail path shows not found

A detail path holding an invalid percent escape shows the not-found message instead of failing the render.

## Consecutive filter changes both apply

Two `setFilters` calls in the same tick both reach the URL; the second does not overwrite the first.

## An unlisted agent stays visible

An `agent` value in the URL that is not one of the known agents is still shown as the selected value of the agent field.

## The view bundle imports no server modules

No file under `view/src` may import at runtime a `src/fork/usage` module that reaches a `node:` builtin or a package, because Vite would bundle it for the browser and fail.

Type-only imports are erased and do not count.

`tests/usage-view-imports.test.ts` walks the import statements statically and lists any chain that breaks the rule.
