---
lat:
  require-code-mention: true
---

# Fork Stop Sync Message

Tests in [[tests/fork-stop-sync-message.test.ts]] for [[src/fork/stop-sync-message.ts#stopSyncMessage]], the sync-only reminder text of [[cli#hook#Stop]].

## Does not tell the agent to run lat check

With and without listed sections, the message neither says "run `lat check`" nor "`lat check` at the end". It says the hook found no `lat check` errors.

## Says editing the listed sections clears the reminder

With listed sections, [[src/cli/hook.ts#formatStopReason]] says to edit each section listed below and that the reminder then clears. The "Sections linked to modified code:" line appears exactly once. Without listed sections the message does not say "listed below".

## Says the reminder is shown once

With and without listed sections, the message says it is shown once for these code changes.

## Counts the lines

The message states the code line count, and either "was not updated" for 0 `lat.md/` lines or "may not be fully in sync" with the line count.

## Keeps the check failed messages

The two messages used when `lat check` failed are the same strings as before this change.
