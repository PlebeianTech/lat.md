---
lat:
  require-code-mention: true
---
# Comment Guard

Functional tests for the blocking half of the comment convention: the `PreToolUse` gate that refuses an `Edit`/`Write`/`MultiEdit` writing a multi-line rationale comment, and tells the agent to move the prose into `lat.md/` behind a `@lat:` pointer.

Tests in `tests/comment-guard.test.ts`. The advisory `PostToolUse` half is [[comment-reminder]]; the two differ in that this one denies the write before it lands and never deduplicates.

## Blocks a multi-line rationale comment

Two or more candidate comment lines in one write produce a denial reason naming the file and the `@lat:` pointer syntax.

The threshold is the whole gate, so this is the case that must fail if `BLOCK_THRESHOLD` drifts.

## Allows a single bare-fact comment

One comment line is the case the convention explicitly permits — a unit, a bound, what null means — and passes without a denial.

## Allows a comment that is already a pointer

Lines carrying `@lat:` are dropped before counting, so a write consisting only of pointers is never refused. This is the compliant state the gate is steering toward, and blocking it would make the instruction impossible to follow.

## Honours an explicit ignore token

A line carrying the `lat:ignore` token is dropped before counting, matching the token [[src/code-refs.ts]] already honours.

The opt-out is per line rather than per file so a deliberate exception stays visible in the diff instead of silently disarming the gate for everything that follows.

## Never gates markdown

A `.md` path is never refused. `FAMILIES` is the single place deciding eligibility and no family claims `.md`, so this test guards that list rather than a separate extension check.

## Fires every time, with no per-session dedup

Two identical writes to the same file both produce the same denial. [[comment-reminder]] deliberately reminds only once per file per session; a gate that fired once would let every subsequent rationale block through.

## Fails open on an unusable payload

A payload naming no file returns no denial. Every fallible step degrades to allowing the edit, because refusing every write in a session over a missing `git` binary is a far worse failure than missing one comment.
