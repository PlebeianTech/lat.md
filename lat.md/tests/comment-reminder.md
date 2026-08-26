---
lat:
  require-code-mention: true
---
# Comment Reminder

Functional tests for the write-side `@lat:` comment reminder: the `PostToolUse` hook heuristic that nudges an agent to add a code ref when it writes a rationale-bearing comment, and the per-agent dispatch that reaches it.

Tests in `tests/comment-reminder.test.ts`.

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

## git timeout

The `git rev-parse` lookup that resolves the project root carries an explicit timeout, so a hung git returns no reminder instead of blocking the Edit that triggered it.
