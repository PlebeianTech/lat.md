---
lat:
  require-code-mention: true
---

# Fork Stop Reminder Memory

Tests in [[tests/fork-stop-reminder-memory.test.ts]] for [[src/fork/stop-reminder-memory.ts]], which lets [[cli#hook#Stop]] issue the sync reminder once per set of code changes.

Each test calls [[src/cli/hook.ts#getStopStatus]] in a temporary git repository. The repository has a committed `lat.md/` and an uncommitted change of 100 lines to `src/app.ts`, which is large enough to need a sync.

## Unchanged code changes are reminded once

The first call reports `needsSync` true. The second call on the unchanged tree reports `needsSync` false and no impacted sections.

## New code changes are reminded again

After the reminder is suppressed, one more line in `src/app.ts` makes the next call report `needsSync` true again.

## Doc edits do not renew the reminder

An edit to a file under `lat.md/` between two calls changes the `lat.md/` line count but not the remembered code state, so the second call reports `needsSync` false.

## Check errors block on every call

With a broken wiki link in `lat.md/`, `checkFailed` is true on every call. Only the sync reminder is suppressed on the second call.

## The remembered state stays out of git status

`git status` of the temporary repository is the same before and after the calls, so the remembered state is never a project change.
