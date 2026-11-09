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

Editing a field of the filter bar writes its parameter, one of `from`, `to`, `agent`, `session` and `issue`, to the query string and exposes the new value through `useUsageFilters` to every page. Clearing a field removes its parameter.

## Loading a URL with filters restores them

A page opened on a URL carrying filter parameters shows those values in the filter bar and exposes them through `useUsageFilters`.

## Navigation keeps the filters

Following a navigation entry keeps the filter parameters in the query string.

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
