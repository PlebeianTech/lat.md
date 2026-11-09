---
lat:
  require-code-mention: true
---

# Usage MCP Tool

Tests in `tests/usage-mcp-tool.test.ts` for the `lat_usage` MCP tool in `src/fork/usage/mcp-usage-tool.ts`, registered by `registerForkMcp` in `src/fork/usage/mcp-registration.ts`.

The tests run a real MCP server with an in-memory client and seed `.lat/usage/` with events, so they cover registration, filtering and the shape of the JSON an agent receives.

## Registered only with a usage directory

`lat_usage` is listed when `.lat/usage/` exists at server start and absent when it does not. `LAT_USAGE=1` alone does not register it, so the upstream exact-list tool tests stay valid in a shell that sets it.

## Summary view returns filtered totals

The default view returns JSON with the totals, the health signals and the savings estimate. An unknown total is `null`, never 0. The `agent`, `session`, `issue` and `since` arguments each narrow the result.

## Savings is a range

The savings entry carries the low and high bounds, the method version and the correlation label, or an unknown value with a reason. It is never one bare number.

## Issue rows are not additive

Issue rows carry their own totals and a note that they overlap. The tool adds no grand total over them.

## Findings view returns ranked findings

`view: "findings"` returns the ranked findings from the findings engine as JSON, capped at ten findings and five evidence lines each, with the total number of findings reported.

## Disabled returns an empty result

When `.lat/usage/` disappears after the server started, the tool returns an empty result with a reason instead of an error.

## Calls are recorded

A call to `lat_usage` writes an `mcp` usage event like any other tool, because the tool is registered after the tap.
