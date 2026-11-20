---
lat:
  require-code-mention: true
---

# Fork Read Ref Hooks

Tests in [[tests/fork-read-ref-claude-hook.test.ts]] for [[src/fork/read-ref-claude-hook.ts#claudeReadRefAdvice]], which gives Claude Code advice after a Read touches `@lat:` references, and for the wiring that runs it from [[cli#hook#PostToolUse]]. Each hook test runs the built CLI against a temporary git project.

## A Read of referenced lines prints advice

A Read payload for a source file whose lines hold a `@lat:` reference prints PostToolUse `additionalContext` that names the target, and exits 0.

## The Read range comes from offset and limit

A Read whose `offset` and `limit` exclude the line with the reference prints nothing.

## A repeated Read in the same session prints nothing

The same Read payload sent twice with the same `session_id` prints advice only the first time.

## A Read without references prints nothing

A Read of a source file with no `@lat:` references prints nothing and exits 0.

## Malformed input prints nothing

Malformed JSON on stdin prints nothing and exits 0.

## lat init adds a Read entry for Claude Code

`syncLatHooks` for Claude Code writes a PostToolUse entry with matcher `Read` after the unchanged `Edit|Write|MultiEdit` entry. Both run `lat hook claude PostToolUse`.

## lat init for Codex is unchanged

`syncLatHooks` for Codex writes the same hooks file as before the Read entry existed: no `Read` matcher.

## The plugin has a Read entry without the index fix

The plugin's `hooks/hooks.json` has one PostToolUse entry with matcher `Read`. It runs `lat-guard.sh hook claude PostToolUse` with a 10 second timeout and does not run `check index --fix`.

## The plugin defers to a project that ran lat init

When the project's `.claude/settings.json` contains `hook claude PostToolUse`, `hooks/lat-guard.sh` prints nothing for a Read payload. This is the documented deferral: such a project gets Read advice only after `lat init` installs its own Read entry.
