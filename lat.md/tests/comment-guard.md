---
lat:
  require-code-mention: true
---
# Comment Guard

Functional tests for the blocking half of the comment convention: the `PreToolUse` gate that refuses an `Edit`/`Write`/`MultiEdit` writing a multi-line rationale comment, and tells the agent to move the prose into `lat.md/` behind a `@lat:` pointer.

Tests in `tests/comment-guard.test.ts`. The advisory `PostToolUse` half is [[comment-reminder]]; the two differ in that this one denies the write before it lands and never deduplicates.

## Blocks a multi-line rationale comment

Two or more candidate comment lines in one write produce a denial reason naming the file and the `@lat:` pointer syntax.

The threshold is the whole gate, so this is the case that must fail if `PROSE_THRESHOLD` in [[src/cli/comment-reminder.ts#judgeWrittenComments]] drifts.

## Allows a single bare-fact comment

One comment line is the case the convention explicitly permits — a unit, a bound, what null means — and passes without a denial.

## Allows a comment that is already a pointer

Lines carrying `@lat:` are dropped before counting, so a write consisting only of pointers is never refused. This is the compliant state the gate is steering toward, and blocking it would make the instruction impossible to follow.

## Honours an explicit ignore token

A line carrying the `lat:ignore` token is dropped before counting, matching the token [[src/code-refs.ts]] already honours.

The opt-out is per line rather than per file so a deliberate exception stays visible in the diff instead of silently disarming the gate for everything that follows. The filter lives in [[src/cli/comment-reminder.ts#isCandidateCommentLine]] so both halves honour it identically — see [[comment-reminder#Honours the same opt-out token as the guard]].

## Never gates markdown

A `.md` path is never refused. `FAMILIES` is the single place deciding eligibility and no family claims `.md`, so this test guards that list rather than a separate extension check.

## Fires every time, with no per-session dedup

Two identical writes to the same file both produce the same denial. [[comment-reminder]] deliberately reminds only once per file per session; a gate that fired once would let every subsequent rationale block through.

## Fails open on an unusable payload

A payload naming no file returns no denial. Every fallible step degrades to allowing the edit, because refusing every write in a session over a missing `git` binary is a far worse failure than missing one comment.

## Allows a whole-file rewrite that changes nothing

A `Write` re-emitting an existing file verbatim is not denied, however many comment lines the file already holds.

A `Write` carries the whole file, not a delta, so counting `content` as written made the gate refuse edits that added no prose at all. The remediation it printed — move the reasoning out, leave a pointer, re-apply — described nothing the agent could do, because there was no new reasoning. [[src/cli/comment-reminder.ts#judgeWrittenComments]] now counts only lines the write actually introduces.

The diffing is scoped to this half. [[comment-reminder]] still speaks for the same rewrite, because after the write disk is no longer evidence of what was already there — see [[comment-reminder#Counts every comment line a whole-file write emits]].

## Allows an edit that re-emits an existing comment block

An `Edit` whose `new_string` carries an unchanged doc comment along with the code it changes is not denied.

`new_string` looks like a delta but is not one: it re-emits the lines bracketing the change, so editing code next to a JSDoc block counted that block as freshly written prose. Observed live on `cleanUntrusted` in [[src/untrusted.ts]] — the denial cost a security-relevant doc comment, because the only exits on offer were deleting it or exempting it line by line.

Asserted twice, once with the payload's `old_string` and once without, because the two take different baselines and only the first is the shape a real agent sends.

## Measures an edit against its own old_string

An `Edit` adding a genuinely new two-line block is denied even when one of those lines already appears, unrelated, elsewhere in the file.

Diffing `new_string` against the whole file was the wrong scope: any coincidental duplicate anywhere in the file cancelled a line, dropping a real prose block under the threshold. `old_string` is the exact text being replaced, so the difference against it is the true delta, and it needs no file read — the same number at `PreToolUse` and `PostToolUse`.

## Denies a block grown one line per edit

Three sequential `Edit`s that add one comment line each, with the file updated in between, are allowed at the first and denied at the second and third.

Counting only new lines let an arbitrarily long rationale block be grown one line at a time and never reach the threshold — and the denial's own text recommends `Edit` over `Write`, so it advertised the technique. The gate therefore judges the *block the edit leaves behind*: a run of adjacent comment lines is flagged as soon as one of them is new. Re-emission stays free because a run with no new line in it is never flagged.

## Counts scattered one-liners together

Two new one-line comments in different places in one write are denied together, and the count names both.

Adjacency alone would let a scattered write past: two isolated lines of prose are still two lines of prose. The run rule and this accumulating count are both needed, and this case is what stops the run rule from quietly weakening the gate.

## Fails closed when the file cannot be read

A whole-file `Write` carrying a rationale block is denied when the baseline is unreadable — a path that does not exist, or a directory.

Everything *else* in the gate fails open, because refusing every write over a missing `git` binary is worse than missing a comment. The baseline is the exception: an unreadable file is no evidence that the prose was already there, so it is treated as new. This is the one direction where absent evidence must not become permission.

## Still blocks new prose beside a re-emitted block

An `Edit` that re-emits an existing doc comment *and* adds two new rationale lines is denied, and the count names only the two added lines.

Diffing against disk must narrow what the gate counts, not what it refuses. This is the companion case to the one above, in the same run, so a change that made re-emission free by making the gate toothless would fail here.

## Still blocks new prose in a whole-file rewrite

A `Write` that re-emits an existing file *and* appends a two-line rationale block is denied, and the count names only the two added lines.

This is the companion to the case above: diffing against disk must not turn the gate off for whole-file writes, only stop it counting text that was already there.

## Names both exits in the denial

The denial text names the two ways out — the per-line ignore token, and using `Edit` rather than a whole-file `Write`.

An agent that cannot comply and cannot see an exit retries. Both exits are stated because the remediation steps do not fit every denial, and the message is read by a model under pressure.
