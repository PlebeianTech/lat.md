---
lat:
  require-code-mention: true
---

# Fork Section Edges

Tests in [[tests/fork-section-edges.test.ts]] for [[packages/core/src/fork/section-edges.ts]], which classifies `@lat:` code reference roles and formats citation coordinates for [[packages/core/src/cli/section.ts#formatSectionOutput]].

## Classify test directory prefixes

[[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] classifies paths starting with `tests/`, `test/`, `__tests__/`, or `spec/` as `'test'`.

## Classify nested test directories

[[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] classifies paths containing nested `/tests/`, `/test/`, `/__tests__/`, or `/spec/` segments as `'test'`.

## Classify test file suffix patterns

[[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] classifies files matching `.test.<ext>` or `.spec.<ext>` suffixes as `'test'` regardless of parent directory.

## Normalize path separators before role classification

[[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] normalizes Windows backslashes to POSIX forward slashes before evaluating test path patterns.

## Classify production source files as code

[[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] classifies source files outside test directories and without `.test.`/`.spec.` suffixes as `'code'`.

## Similar substring paths without boundary segments return code

[[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] checks segment boundaries so paths like `src/testing/runner.ts` or `src/specification.ts` classify as `'code'`.

## Format incoming location with file and positive line

[[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] formats a markdown file path and positive line number into a parenthesized ` (file:line)` coordinate string.

## Format incoming location appends missing markdown extension

[[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] appends `.md` when the input file stem omits the extension.

## Format incoming location calculates relative path from working directory

[[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] computes POSIX-normalized paths relative to the current working directory.

## Format incoming location returns empty string for missing file

[[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] returns `''` when the `file` argument is `undefined` or empty.

## Format incoming location returns empty string for non positive line

[[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] returns `''` when the `line` argument is `undefined`, `0`, negative, or `NaN`.

## Format section output renders backlink citation coordinates

[[packages/core/src/cli/section.ts#formatSectionOutput]] renders `(file:line)` coordinates from [[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] on incoming `Referenced by` lines.

## Format section output preserves backlinks lacking citation coordinates

[[packages/core/src/cli/section.ts#formatSectionOutput]] omits coordinate parentheses when an incoming [[packages/core/src/lattice-model.ts#SectionMatch]] lacks `citeFile` or `citeLine`.

## Format section output labels test code backlinks

[[packages/core/src/cli/section.ts#formatSectionOutput]] appends `[test]` via [[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] on code backlinks originating in test files.

## Format section output labels production code backlinks

[[packages/core/src/cli/section.ts#formatSectionOutput]] appends `[code]` via [[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] on code backlinks originating in production source files.

## Format section output renders mixed code backlink roles

[[packages/core/src/cli/section.ts#formatSectionOutput]] renders `[test]` and `[code]` role badges side by side when both test and production files reference a section.

## Subtree descendant code references preserve snippet and line formatting

[[packages/core/src/cli/section.ts#formatSectionOutput]] preserves the 5-line source snippet and line number alongside the role badge for descendant subsection code backlinks.

## End to end section query populates backlink citation coordinates

[[packages/core/src/cli/section.ts#getSection]] copies `citeFile` and `citeLine` from incoming wiki links onto [[packages/core/src/lattice-model.ts#SectionMatch]] records for [[packages/core/src/cli/section.ts#formatSectionOutput]].

## End to end section query badges code backlink roles

[[packages/core/src/cli/section.ts#getSection]] and [[packages/core/src/cli/section.ts#formatSectionOutput]] scan repository fixtures and badge code backlinks with `[code]`.

## Core package subpath export resolves section edges module

`packages/core/package.json` exports `@plebeiantech/lat.md-core/fork/section-edges`, resolving [[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] and [[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]].

## Backlink output labels and coordinates exclude em dashes

[[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]] and [[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]] produce strings with zero Unicode em dashes and zero en dashes.
