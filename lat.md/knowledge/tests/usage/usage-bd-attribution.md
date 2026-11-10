---
lat:
  require-code-mention: true
---

# Usage bd Attribution

Tests in `tests/usage-bd-attribution.test.ts` for `src/fork/usage/bd-attribution.ts` and `src/fork/usage/bd-client.ts`. They use synthetic issues, session events and journal records, and a stubbed bd runner. None reads the live bd database.

## Claim to close attributes a session's events

Events in a session from the `bd update X --claim` event to the `bd close X` event, both ends included, belong to X with method `claim`. Events before the claim and after the close are unattributed.

## Two open issues share their events

When two unrelated issues are open in one session, an event is attributed to both and marked shared.

A shared event counts in full in each issue's own list, with no splitting, so per-issue totals must not be summed across issues.

## Nested claims credit the most specific issue

When a claimed issue is an ancestor of another matched issue, the event is attributed to the descendant only and is not shared. The ancestor receives it through the rollup, once. The same holds on the timestamp path.

## Closes in any session end a claim

The first close of an issue in any session ends every claim open for it, so a subagent's close ends its parent's claim. A claim nothing closed is capped at the snapshot's `closed_at`, and a repeated claim is one interval.

## A session spanning two issues in sequence

Events after the first close and after the second claim belong to the second issue only.

## An issue spanning several sessions

Each session's own claim and close bound that session's events. A second session that never claimed the issue gets nothing from the first session's claim.

## Subagent sessions use the parent claim

An event in a subagent session with no claim of its own is attributed through the claims of its parent session, and through its grandparent when the parent has none. A claim in the subagent itself takes precedence.

## A parent session event takes the claim of one subagent

The CLI tap records a Claude subagent's lat commands under the parent session id. When an event's own session and its ancestors have no claim open at its time, the claims of the session's direct child sessions are used, with method `claim`.

The event is credited only when the open child claims name exactly one issue. Two children with different open issues leave it as before, and a claim in the session or an ancestor takes precedence.

## Timestamp fallback

An event with no open claim inside an assigned issue's `started_at` to `closed_at` window is attributed with method `timestamp`.

The window edges are included and an event just outside is not. An in-progress issue with no `closed_at` stays open. An issue with no assignee or no `started_at` never matches.

## Rollup through two levels of parent-child

An epic shows its own events plus those of its sub-epic and tasks at any depth. An event credited to both a parent and its child counts once for the parent.

## Issue facts travel with the attribution

The result carries each issue's title, status and issue type.

## Unattributed bucket

An event that matches no claim and no window is attributed to no issue with method `unattributed`. A claim naming an issue bd does not know is ignored.

## bd unavailable

With bd missing, failing, or `BEADS_DIR` unset, loading returns null and attribution returns unattributed for every event. Nothing throws.

The runner ends bd's stdin at once, so a bd that reads stdin gets end of input instead of waiting for the call timeout.

## Discovered-from links

A `discovered-from` dependency is returned with the discovered issue's and the source issue's type and creation time, and the time of the link.

## Reopen detection from the events journal

The first journal row after a close whose state is not closed is a reopen, and detection returns its time and the time of the close it followed.

`bd reopen` clears `closed_at`, and the journal has no reopen op: with a reason it writes a comment row and then an update row. The test replays a journal captured from a throwaway bd database on 2026-11-08. An ordinary update, a first-time claim, and a reopen whose close was pruned from the journal are not reported. A tail continues the replay from the previous status and close time. An edit of an issue that is already closed keeps the first close time.

## Watcher re-tails only when the database changes

An unchanged fingerprint makes no bd call. A change with new journal rows extends the reopen list from the checkpoint. A change with no journal rows, or a tail that fails, re-baselines from the full export.
