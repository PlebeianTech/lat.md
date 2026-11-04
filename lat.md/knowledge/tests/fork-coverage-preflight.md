---
lat:
  require-code-mention: true
---

# Fork Coverage Preflight

Tests in [[tests/fork-coverage-preflight.test.ts]] for [[src/cli/fork-coverage-preflight.ts]], which surfaces ungrounded source file paths during [[src/cli/hook.ts#handleUserPromptSubmit]] preflight execution.

## Empty prompt returns empty array

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] returns an empty array when the prompt is empty or contains no file path tokens.

## Grounded file with direct wiki link returns empty array

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] treats a source file targeted by a `lat.md/` wiki link as grounded via [[src/cli/fork-coverage-preflight.ts#isPathWikiGrounded]] and omits it from gap results.

## Grounded file with parent directory wiki link returns empty array

[[src/cli/fork-coverage-preflight.ts#isPathWikiGrounded]] walks ancestor directories against [[src/cli/fork-coverage-preflight.ts#buildWikiGroundedSet]] so files inside a linked directory are treated as grounded.

## Grounded file with only in-file code ref comment returns empty array

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] scans candidate source files for `@lat: [[...]]` comments and treats matching files as grounded even without incoming `lat.md/` wiki links.

## Genuinely ungrounded source file detected and returned

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] detects existing source files lacking both incoming `lat.md/` wiki links and in-file `@lat:` comments and returns them in sorted order.

## Path with punctuation quotes symbol and line coordinates normalized

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] strips surrounding quotes, brackets, `#symbol` anchors, and `:line:col` suffixes before resolving candidate paths.

## Tooling and config files excluded from detection

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] excludes config files, `.d.ts` declarations, and non-source assets from coverage gap detection.

## Nonexistent files and directory paths excluded

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] validates candidate paths with [[packages/core/src/repository-path.ts#repositoryFilePath]] so nonexistent files and directory paths are ignored.

## Directory traversal attacks and absolute paths excluded

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] rejects `..` parent traversal sequences and paths outside the project root via [[packages/core/src/repository-path.ts#repositoryFilePath]].

## Candidate inspection capped at ten paths

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] caps evaluation at 10 unique candidate paths per prompt to bound filesystem reads.

## Notice formatting returns null on empty and formatted text on ungrounded files

[[src/cli/fork-coverage-preflight.ts#formatCoverageGapNotice]] returns `null` for an empty list and formats a coverage notice sanitized with [[packages/core/src/untrusted.ts#cleanUntrustedId]] when ungrounded files exist.

## Section wiki links do not falsely ground files in matching directories

[[src/cli/fork-coverage-preflight.ts#buildWikiGroundedSet]] ignores bare document section stems without `/` or a source extension so files in identically named directories remain detected as ungrounded.

## Hook integration appends notice without breaking execution

[[src/cli/hook.ts#handleUserPromptSubmit]] calls [[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] and [[src/cli/fork-coverage-preflight.ts#formatCoverageGapNotice]] inside a `try/catch` block that fails open on errors.
