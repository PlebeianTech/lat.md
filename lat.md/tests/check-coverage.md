---
lat:
  require-code-mention: true
---

# Check Coverage

Tests for [[src/cli/check-coverage.ts#checkCoverage]], the floor that fails a `lat.md/` tree holding documents that no `@lat:` ref anywhere in the codebase reaches.

Tests in `tests/check-coverage.test.ts`. Half of them assert the message rather than the verdict, because the message is what has to answer the two reasons an agent gives for skipping the ref.

## A documented tree with no refs fails

A project with a document beside its root index and a source file carrying no ref produces exactly one error.

One error and not one per document: the finding is about the tree, and repeating it per file would bury the remediation under its own repetition.

## One ref anywhere clears it

A single `@lat:` ref in any file satisfies the check.

The floor is deliberately one. A per-document rule would fail this repository, where `dev-process`, `markdown`, `parser`, `website` and everything under `view/` have no incoming ref and should not be forced to grow one.

## A ref in any comment syntax counts

A `#`-marked ref in a `.rb` file is counted, which is the case an agent got wrong by reading a list of example markers as a list of supported languages.

## An index-only tree is not asked for a ref

A tree whose every file is a directory index passes. There is nothing to anchor yet.

## A project with no scannable code is not asked for a ref

A tree with no source files passes, so documentation-only repositories are unaffected.

## The remediation quotes a ref that resolves

The message names the root index's own H1, so the suggested line can be pasted as-is.

A generic placeholder would be pasted verbatim and then fail [[cli#check#code-refs]], turning one error into two.

## The message answers both reasons an agent skips the ref

The text states that an `@lat:` pointer is a machine directive no comment-minimising convention reaches, and that the marker is a comment syntax rather than a language allowlist.
