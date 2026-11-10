---
lat:
  require-code-mention: true
---

# Usage Output Parsers

Tests in `tests/usage-output-parsers.test.ts` for the parsers in `src/fork/usage/output-parsers.ts` and the stdout capture in `src/fork/usage/cli-tap.ts`. The parsers read recorded command output and return ids, never copies of the text.

## Search ids keep rank order

`parseSearchOutput` returns the ids from lines that start with an asterisk, `Section:` or `File:` and an id in double square brackets, in printed order. Bracketed refs inside a preview are ignored.

## Section id comes from the first line

`parseSectionOutput` records the id on the first line as the section id with `found` true. Refs in the body are ignored. A non-zero exit with nothing printed gives `found` false.

## Expand records the best match per ref

`parseExpandOutput` returns the first resolved id of each ref inside the `lat-context` block, in order, and never a section id. Quoted summaries and alternatives are ignored.

## Hook ids come from the search results list

`parseHookOutput` reads `additionalContext` from the JSON and takes only the bullet ids under the heading `Search results for the user prompt`. The Stop hook's linked-sections list is skipped.

When one match printed its full body, that section is also the section id.

## Every injected text field counts

`injected_bytes` is the sum of the UTF-8 byte lengths of every text field in the hook's JSON that reaches the agent.

The fields are `hookSpecificOutput.additionalContext`, `hookSpecificOutput.permissionDecisionReason` (a PreToolUse deny), a top-level `reason` (a Stop block), Cursor's `additional_context` and `followup_message`, and each `injectSteps[].ephemeralMessage` (Antigravity). Result ids still come from `additionalContext` only. A JSON object with none of these fields, such as `{"decision":"allow"}`, `{"injectSteps":[]}` or `{}`, injected nothing, so `injected_bytes` is 0. Output that is not a JSON object, such as plain text or an array, keeps `injected_bytes` null.

## ANSI codes are stripped

Every parser strips ANSI colour codes before it matches.

## Counts and bytes come from the capture

`bytes_out` is the byte length of what the command printed, for every command. `result_count` is the number of result ids whenever result ids are set.

## A search with no query has no result count

`lat search` with no query, or with an empty query such as `lat search ""`, only rebuilds the index and prints nothing. Its event keeps `result_count` null with its reason, so it never counts as a search that found nothing.

## Output passes through unchanged

While the tap captures standard output, the command writes the same chunks to the same stream and returns the same value. The stored event holds ids, counts and byte lengths, never output text.

## A throwing parser leaves the event

When a parser throws, the event is still written, with the parsed fields null and a reason, and `bytes_out` still set.

## Long-running commands are not captured

`lat mcp`, `lat ui` and `lat ui run` keep standard output untouched and record no `bytes_out`. `lat ui build server` ends, so it is captured.

## Retained output is capped

The tap counts every byte but keeps output text only for the commands a parser reads, and only up to 1 MiB. Past the cap `bytes_out` stays exact and the parsed fields are null with `not_captured`.
