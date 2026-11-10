---
lat:
  require-code-mention: true
---

# Usage Miss Consequences

Tests in `tests/usage-miss-consequences.test.ts` for `src/fork/usage/miss-consequences.ts`.

Most tests hand the pure builder fixture sessions, session spans, a bd snapshot and failed-run counts. The wiring tests run the contribution over a temporary directory with real transcript lines, and stub the missed-knowledge analysis the way the section scorecard tests do.

The result lands in `extensions.miss_consequences`. It carries `method_version` and the label "correlation, not cause": the groups differ in more than their misses, so no difference is a measured cause. Every measure reports its sample size. Unknown is null with a reason, never 0.

## Sessions are grouped by whether they reached every expected section

A session with expected sections whose every section was reached is in the reached-everything group. A session with at least one miss is in the had-a-miss group. A session with no expected sections is in neither group and is counted as excluded.

## Issues are grouped from their sessions

An issue is in the had-a-miss group when any of its sessions had a miss, and in the reached-everything group when all of them reached everything.

Only sessions with expected sections count. An issue with none is in neither group.

## Rework is a later session editing the same file within 3 days

A session is reworked when another session starts within 3 days after it ends and edits a file the first one edited.

The later session may be in any worktree of the repository, because paths are worktree-relative. A later session after 3 days, or one that starts before the end, does not count.

## A session too recent for its window is left out and counted

Rework, follow-up bugs and reopens count only sessions and issues whose full window ended at or before the last event in the data. The rest are left out, and the count of those left out is reported per measure.

## A follow-up bug is a bug discovered from the issue within 14 days after close

A bug linked by a discovered-from dependency counts when it was created after the issue closed and within 14 days.

A bug created before the close, after 14 days, or of another type does not count. An issue never closed is excluded and counted.

## A reopen counts inside the window and the journal retention

An issue reopened within 14 days of closing counts. A reopen on day 15 does not.

The reopen source is the bd events journal, which keeps 7 days by default, so the window is limited to half the retention (3.5 days by default). An issue must close inside the retention and its window must end by the last event; a window as long as the retention would leave no such issue unless the last event is now. Issues closed before the retention are left out, and the limit is reported with the result. An issue never closed is excluded.

`bd reopen` clears `closed_at`, so a reopened issue's close time is the journal close that its first reopen followed. A reopened issue counts whether it is still open or was closed again. A reopen counts only when it falls inside the window. A journal close time that does not parse is left out as close time unknown. An issue closed before the retention is left out whether or not it was reopened. One window decides completeness and counting.

## Failed test runs count only listed runners with a non-zero exit

A shell call counts when its command starts with a listed test runner and its exit code is non-zero. A listed runner with exit code 0 and an unlisted command do not count.

A null exit code is not counted as a failure. A session with a test run whose exit code is null and no known failed run is unknown: it is counted in `unknown_sessions`, not in the sample.

## Test runner matching splits compound commands

The command is split on `&&`, `||`, `;` and `|`, and leading `VAR=value` assignments are dropped from each part before the prefix list applies. `NODE_OPTIONS=x pnpm vitest` and `cd a && pnpm test` match. `echo pnpm test` does not.

A `bash -lc` or `sh -c` wrapper, or a Codex argv array, is unwrapped first. A quoted `;` does not split.

## The command is re-read through the source pointer and never stored

State holds no command text. A failed shell call is re-read through its source path and offset. Only a verdict is kept. A call whose source cannot be read makes the session's count unknown, which is reported and left out of the rate.

## Effort is tokens and duration per issue

Each group reports, per token counter, the median of the issue totals, and the median session duration per issue, with the issues measured and unknown.

Counters are never merged. Tokens and duration come from the issue's own sessions over the same span: the whole session, even when it crosses the start of the range. Duration skips subagent sessions. An issue with only subagent sessions has unknown duration, not 0.

A counter total is the sum of its known values, with known and unknown counts. An issue whose counter is all unknown is unknown, not zero.

## The result is labelled a correlation and reports every sample size

The result carries the method version and the label "correlation, not cause". Every measure reports its sample, and a measure with no sample is null with a reason.

## A failing missed-knowledge analysis is an error, not zeros

When the missed-knowledge prepare or compute throws, the extension is `{ error }`, never a result of zeros.
