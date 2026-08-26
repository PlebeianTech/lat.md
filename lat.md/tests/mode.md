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
