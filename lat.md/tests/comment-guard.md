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

The opt-out is per line rather than per file so a deliberate exception stays visible in the diff instead of silently disarming the gate for everything that follows. The filter lives in [[src/cli/comment-reminder.ts#candidateCommentLines]] so both halves honour it identically — see [[comment-reminder#Honours the same opt-out token as the guard]].

## Never gates markdown

A `.md` path is never refused. `FAMILIES` is the single place deciding eligibility and no family claims `.md`, so this test guards that list rather than a separate extension check.

## Fires every time, with no per-session dedup

Two identical writes to the same file both produce the same denial. [[comment-reminder]] deliberately reminds only once per file per session; a gate that fired once would let every subsequent rationale block through.

## Fails open on an unusable payload

A payload naming no file returns no denial. Every fallible step degrades to allowing the edit, because refusing every write in a session over a missing `git` binary is a far worse failure than missing one comment.

## Allows a whole-file rewrite that changes nothing

A `Write` re-emitting an existing file verbatim is neither denied nor reminded about, however many comment lines the file already holds.

A `Write` carries the whole file, not a delta, so counting `content` as written made the gate refuse edits that added no prose at all. The remediation it printed — move the reasoning out, leave a pointer, re-apply — described nothing the agent could do, because there was no new reasoning. [[src/cli/comment-reminder.ts#extractWrittenText]] now diffs every written fragment against what is on disk first.

## Allows an edit that re-emits an existing comment block

An `Edit` whose `new_string` carries an unchanged doc comment along with the code it changes is not denied.

`new_string` looks like a delta but is not one: it re-emits the lines bracketing the change, so editing code next to a JSDoc block counted that block as freshly written prose. Observed live on `cleanUntrusted` in [[src/untrusted.ts]] — the denial cost a security-relevant doc comment, because the only exits on offer were deleting it or exempting it line by line.

## Still blocks new prose beside a re-emitted block

An `Edit` that re-emits an existing doc comment *and* adds two new rationale lines is denied, and the count names only the two added lines.

Diffing against disk must narrow what the gate counts, not what it refuses. This is the companion case to the one above, in the same run, so a change that made re-emission free by making the gate toothless would fail here.

## Still blocks new prose in a whole-file rewrite

A `Write` that re-emits an existing file *and* appends a two-line rationale block is denied, and the count names only the two added lines.

This is the companion to the case above: diffing against disk must not turn the gate off for whole-file writes, only stop it counting text that was already there.

## Names both exits in the denial

The denial text names the two ways out — the per-line ignore token, and using `Edit` rather than a whole-file `Write`.

An agent that cannot comply and cannot see an exit retries. Both exits are stated because the remediation steps do not fit every denial, and the message is read by a model under pressure.
