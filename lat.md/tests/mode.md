---
lat:
  require-code-mention: true
---
# Diátaxis Mode Check

Tests for `checkMode`'s exemption of imperative sentences that appear inside code samples rather than ordinary prose, for `lat check mode` (see [[cli#check]]).

Tests in `tests/mode.test.ts`.

## Does not flag an imperative inside a nested fence with a longer marker

An imperative sentence inside a fenced code block that uses a longer fence marker than the surrounding document (so the fence nests rather than closing early) is not flagged as a mode violation.

## Does not flag an imperative inside a four-space-indented code block

An imperative sentence inside a four-space-indented code block — Markdown's other code-block syntax, not just fenced blocks — is not flagged.

## Still flags only the single ordinary-prose imperative

Given a document containing both code-sample imperatives (exempt) and one imperative in ordinary prose, `checkMode` reports exactly the one prose violation.

## Does not flag an imperative inside a frontmatter block scalar

An imperative sentence carried on a continuation line of a YAML block scalar in the frontmatter is not flagged, because frontmatter is not prose.

The fixture uses a block scalar rather than a plain `key: value` line on purpose. A plain scalar puts the key before the verb, so the line never begins with an imperative and the check never fires — the test would pass with the frontmatter exemption removed entirely. Only a continuation line begins with the verb itself.

## Flags the exempted sentences when they appear as prose

A second document in the same fixture repeats, as ordinary prose, the exact sentences that the first keeps inside its frontmatter and its fenced blocks. Both are flagged.

Without this pair, every exemption test is satisfied by a detector that simply never fires on those sentences — dropping `Run` from `IMPERATIVE_VERBS` would leave the fence and frontmatter tests green. The pair pins the exemption to position rather than to wording.

## Does not treat an Object.prototype key as a mode directory

A document under a directory named for an inherited `Object.prototype` member — `constructor`, `toString` — is not matched against a Diátaxis mode by that name.

The directory-to-mode table is keyed on a name read off disk. Built as an ordinary object it answers `constructor` with a `Function`, which reads as a directory-versus-declaration mismatch for a document declaring a real mode, and as an unrecognized mode that matches no shape rule — validating nothing, silently — for one declaring none.
