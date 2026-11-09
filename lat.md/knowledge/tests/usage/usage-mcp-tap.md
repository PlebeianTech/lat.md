---
lat:
  require-code-mention: true
---

# Usage MCP Tap

Tests in `tests/usage-mcp-tap.test.ts` for the MCP tool-call tap in `src/fork/usage/mcp-tap.ts`, installed by `registerForkMcp` in `src/fork/usage/mcp-registration.ts`.

The tests register stand-in tools on a real MCP server and call them through an in-memory client, so they cover the wrapping and not the tools.

## Registration taps every tool

`registerForkMcp(server)` wraps tool registration. A tool registered afterwards writes one `mcp` event per call, with the fields the CLI tap fills.

Those are the command name without its `lat_` prefix, the query, the caller, the agent, `exit_code` and `lat_version`.

## Search records ids in rank order

A `lat_search` call records the section and file ids it returned in printed order as `result_ids`, and `result_count` is their number.

## Section records the section id

A `lat_section` call records the id on the first line of its result as `section_id` with `found` true.

## Missing section records found false

A `lat_section` call whose result is an error with no section records `found` false and no `section_id`.

## Expand records resolved ids only

A `lat_expand` call records the resolved ids as `result_ids` and no `section_id`.

## Bytes out is the result length

`bytes_out` is the byte length of the result text, counted in bytes and not characters.

## Results pass through unchanged

With usage on, a tool returns the same result it returns with usage off, and a tool that throws throws the same error.

## The tap never fails a call

A writer that cannot write, a result the parsers cannot read and a project with no lat.md directory leave the tool call as it was. Nothing is written when usage is off.

## Events hold no output text

The stored line holds ids, counts and byte lengths. It holds none of the text the tool returned.
