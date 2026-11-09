---
lat:
  require-code-mention: true
---

# Usage Schema

Tests in `tests/usage-schema.test.ts` for the usage event schema, the session reader contract and the opt-in switch under `src/fork/usage/`.

## Session event ids derive from source path and offset

A session event id is a pure function of the transcript path and the byte offset, so findings and the raw events endpoint can name a session event stably.

The same path and offset give the same id; a different path or a different offset gives a different id.

## Tool calls carry an action and a target path

A tool-call session event holds exactly one action from the exported list `read`, `edit`, `search`, `shell`, plus the path it acted on, so analysis can tell which files an agent read and which it edited.

## Tool paths are relative to the worktree

An absolute transcript path inside the worktree normalizes to a POSIX path relative to the worktree root. A path outside the root stays absolute and never matches a section.

A directory whose name merely starts with two dots, such as `..cache`, is still inside the root.

## Shell calls round-trip command and exit code

A shell tool call keeps its command text and exit code.

Shell data is required for the action `shell` and forbidden for every other action, and the types enforce both. A transcript that does not record the exit code yields null with the reason `not_captured`, never zero.

## Usage is opt-in

`usageEnabled` is true when `.lat/usage/` exists under the root or `LAT_USAGE=1`, and false otherwise.

## Reader stubs report nothing captured

A source built by the `notCapturedSource` factory returns no events and the reason `not_captured`. The five readers start as that stub, registered in `src/fork/usage/sources/index.ts`, until their own issues replace them.

## Every usage issue has a spec file

Each usage issue owns one spec file under `lat.md/knowledge/tests/usage/`, created as a stub and replaced by that issue.

The test checks existence only. Whether a spec carries frontmatter is left to `lat check`.

## Unknown usage fields carry a reason

A usage event never writes zero for a value it could not capture: `result_count` and `bytes_out` may be null.

Every null field that is unknown, rather than not applicable, has an entry in `unknown_reasons` naming why, such as `not_captured`.

## Subagent events name their parent session

Every event of a subagent session carries `parent_session_id`, the session that spawned it.

Top-level sessions omit the field, because it is not applicable and needs no unknown reason.

## Token usage keeps the reported cost

Token usage carries `reported_cost_usd` only when the transcript reports a cost, in US dollars as reported.

It is absent when the agent reports none, and lat never computes cost into it.

## Unknown token counters carry a reason

A token counter the agent does not report is null, never zero, with an entry in the usage record's `unknown_reasons` such as `unsupported_by_agent`.

Readers that report a counter set the number.
