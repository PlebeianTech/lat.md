---
lat:
  require-code-mention: true
---
# Comment Reminder

Functional tests for the write-side `@lat:` comment reminder: the `PostToolUse` hook heuristic that nudges an agent to add a code ref when it writes a rationale-bearing comment, and the per-agent dispatch that reaches it.

Tests in `tests/comment-reminder.test.ts`; the two cases it shares with [[comment-guard]] live in `tests/comment-guard.test.ts`, which asserts both halves at once.

The reminder and the gate share [[src/cli/comment-reminder.ts#judgeWrittenComments]] but not a baseline: [[src/cli/comment-reminder.ts#WritePhase]] tells it which side of the tool call it is on, and only the gate can read the file as pre-edit state.

`hooks/hooks.json` registers both halves on one `Edit|Write|MultiEdit` matcher and a `PreToolUse` deny suppresses `PostToolUse`, so under the plugin the gate answers first and the reminder rarely speaks. The `lat init` wiring registers `UserPromptSubmit`, `Stop` and `PostToolUse` and no `PreToolUse` at all, so there the reminder is the only enforcement the convention has.

## Bare fact comments stay quiet

A one-line comment stating a fact rather than a rationale (`// increment the counter`) produces no hook output.

## Multi-line rationale comment fires once

A multi-line comment explaining *why* (a retry count, a workaround) produces a `PostToolUse` `additionalContext` payload naming the file and suggesting `@lat: [[section-id]]`.

## Does not fire twice for the same file in one session

A second write to the same file in the same session produces no output — the reminder already fired once for it.

## Exits 0 on a malformed payload

A non-JSON stdin payload to the `PostToolUse` hook exits 0 with empty stdout rather than crashing the tool call.

## Stays quiet for a comment that already carries a ref

Content whose comment already contains an `@lat:` reference produces no reminder.

## Stays quiet for decoration with no alphanumeric characters

A comment made entirely of punctuation (dashes, slashes) is not treated as a rationale comment.

## Stays quiet for linter pragmas

An `eslint-disable-next-line` style pragma comment is not treated as a rationale comment.

## Stays quiet for .md files

Markdown files are excluded from the reminder — the heuristic targets source comments, not prose.

## Matches basenames with no extension

Rationale comments in extension-less files named `Dockerfile`, `Makefile`, or `Rakefile` are still recognized and named in the reminder.

## Does not treat a pointer dereference as a comment

C-style `*` pointer dereference lines are not misparsed as line comments.

## Asks for the tree when the project has none yet

When the project has no `lat.md/` tree at all, the reminder's `additionalContext` says so ("no lat.md/ tree yet") instead of suggesting a ref into a tree that doesn't exist.

## Works the same for the Codex agent

The Codex `PostToolUse` adapter produces the same reminder shape (`hookEventName: 'PostToolUse'`) as Claude's.

## Cursor postToolUse dispatch

Cursor's `postToolUse` payload uses different key names and a different output envelope than Claude's, so the dispatcher normalizes it rather than teaching the comment-reminder heuristic a second dialect.

### Accepts postToolUse as a known cursor event

`lat hook cursor postToolUse` does not error with "Unknown hook event".

### Never fails the edit on a malformed payload

A non-JSON payload to the cursor `postToolUse` hook exits 0.

## Honours the same opt-out token as the guard

An edit whose every comment line carries the per-line ignore token draws neither a denial from [[comment-guard]] nor a reminder here.

The two halves once disagreed: the gate filtered the token before counting and the reminder did not, so an agent that took the denial's own advice was immediately told the exempted lines broke the convention. The filter now lives in [[src/cli/comment-reminder.ts#isCandidateCommentLine]], and [[src/cli/comment-reminder.ts#judgeWrittenComments]] is the only thing either half calls, so they cannot drift apart again.

## Speaks once the write has already landed

A `Write` whose `content` is already on disk — the real `PostToolUse` ordering — still produces a reminder naming the file and the count.

The gate subtracts the lines disk already holds, which is right at `PreToolUse` because disk is then the pre-edit state. At `PostToolUse` disk is the write itself, so the same subtraction cancelled the whole payload and the reminder returned `null` at its own empty-text guard. Under `hooks/hooks.json` the gate masked that; under the `lat init` wiring, which registers no `PreToolUse`, the convention lost every trace of enforcement.

## Speaks for an edit that has already landed

An `Edit` whose `new_string` is already spliced into the file on disk still produces a reminder.

`content` and `new_string` travel the same code path, so a fix covering only whole-file writes would have left the commoner shape silent. This case and the one above run together for that reason.

## Counts every comment line a whole-file write emits

A `Write` that re-emits an existing file and appends two comment lines is reported as four, not two: every candidate line in `content` counts, because after the write nothing in the payload can be told apart from what was already there.

That is louder than the gate, and deliberately so. The only quieter reading available to a whole-file `Write` at `PostToolUse` is the one that produced silence. A reminder cannot block anyone, so over-counting costs an ignorable sentence while under-counting costs the convention. An `Edit` is exact in both phases, because it is measured against its own `old_string` — which is what the denial text already tells agents to prefer.

## Fires end to end with the file already written

The built CLI, handed a `PostToolUse` payload whose `file_path` already holds the written `content`, emits `additionalContext`.

Driven through `lat hook claude PostToolUse` rather than the exported function, because the phase bug survived every unit test in this file: none of them created the target file, so all of them took the no-readable-file fast path and passed against a reminder that was completely dead.

## git timeout

The `git rev-parse` lookup that resolves the project root carries an explicit timeout, so a hung git returns no reminder instead of blocking the Edit that triggered it.
