---
lat:
  require-code-mention: true
---
# Hook

Functional tests for Claude, Codex, and Cursor lifecycle hooks. Runs hook commands against fixtures and injects a fake `git` through PATH to control `git diff HEAD --numstat` output.

Tests in `tests/hook.test.ts`.

## Exits silently when check passes and no diff

When `lat check` passes and there is no git diff output, the hook produces no stdout and no stderr — the agent stops cleanly.

## Blocks when lat check fails

When `lat check` finds errors, the hook outputs a block decision with a reason mentioning `lat check` and the error count.

## Blocks when code diff is large but lat.md/ not updated

When check passes but `git diff --numstat` shows code changes above the threshold with no `lat.md/` changes, the hook blocks with a reminder to update `lat.md/`.

## Exits silently when lat.md/ changes are proportional

When code changes are large but `lat.md/` changes exceed the 5% ratio, the hook exits silently.

## Exits silently when code diff is below threshold

When code changes are below 5 lines, the ratio check is skipped and the hook exits silently.

## Blocks with both messages when check fails and diff needs sync

When `lat check` fails and the diff also needs sync, the block reason covers both updating `lat.md/` and running `lat check` until it passes.

## Exits silently on second pass when check passes

On the second pass (`stop_hook_active: true`), if `lat check` passes, the hook exits silently with no output.

## Prints stderr warning on second pass when check still fails

On the second pass, if `lat check` still fails, the hook prints a warning to stderr but does not block — the loop stops.

## Ignores non-code files in diff

Files that don't match `SOURCE_EXTENSIONS` (e.g. `.md`) are not counted toward code lines, so a large markdown-only diff does not trigger a sync reminder.

## Cursor stop hook returns follow-up work instead of a Claude block

When Cursor needs more work at stop time, the hook returns a `followup_message` payload instead of Claude's `decision: "block"` shape so the agent keeps going in Cursor's native hook format.

## Codex stop hook returns a block decision

When Codex needs more work at stop time, the hook returns the same guarded `decision: "block"` continuation payload used for Claude.

## Codex prompt hook reads the Codex prompt field

The Codex `UserPromptSubmit` adapter reads `prompt`, expands wiki links, and returns the resolved prompt as additional developer context.

## Codex hook setup preserves non-lat hooks

Syncing `.codex/hooks.json` removes stale lat-owned entries, installs current prompt and stop commands, and preserves unrelated hook metadata and event handlers.

## Local JavaScript hook commands retain Node

When init runs from a local compiled JavaScript entry point, generated hook commands invoke it through the same Node executable so non-executable `tsc` output works without changing file permissions.

## Blocks on a Diátaxis mode error at stop time

`checkAllCommand` counts Diátaxis mode errors in its total, so the Stop hook's status check has to count them too.

Without this, `lat check` fails on the command line while the Stop hook calls the same tree clean and ends the session with the post-task checklist reported as complete.

Tested in `tests/hook-stop-mode.test.ts`.

## Parses the lat.md tree once per prompt (lat-t1y.23)

`UserPromptSubmit` handling needs the parsed tree for both [[cli#expand]] and [[cli#search]] federation lookups. Threading a preloaded-sections parameter through both call sites avoids walking and parsing the tree twice per prompt.

Tested in `tests/preloaded-sections.test.ts`.

### expandPrompt uses preloaded sections instead of re-parsing the tree

Calling `expandPrompt` with a preloaded `loadAllSections()` result does not call `loadAllSections` again, and produces byte-identical output to the unpreloaded call.

### runSearch resolves matches from preloaded sections without re-parsing the tree

Calling `runSearch` with `preloadedSections` resolves the same matches without calling `loadAllSections`; omitting it still resolves correctly by walking the tree itself.
