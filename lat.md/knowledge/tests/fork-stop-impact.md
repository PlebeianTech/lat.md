---
lat:
  require-code-mention: true
---

# Fork Stop Impact

Tests in [[tests/fork-stop-impact.test.ts]] for [[src/cli/fork-stop-impact.ts]], which intersects git diff line ranges with `@lat:` code references and source wiki links during [[cli#hook#Stop]].

## Empty diff returns empty array

[[src/cli/fork-stop-impact.ts#parseUnifiedZeroDiff]] returns an empty array when the diff string is empty or whitespace-only.

## Unified diff parser parses single hunk line range

[[src/cli/fork-stop-impact.ts#parseUnifiedZeroDiff]] extracts repository-relative paths and inclusive `startLine`/`endLine` coordinates from modified, renamed, added, and `--no-prefix` hunk headers.

## Unified diff parser parses multiple hunks across multiple files

[[src/cli/fork-stop-impact.ts#parseUnifiedZeroDiff]] tracks file header transitions and parses multiple hunks across distinct source files into normalized POSIX ranges.

## Unified diff parser handles zero count deletion hunks

When a deletion hunk has `newCount === 0`, [[src/cli/fork-stop-impact.ts#parseUnifiedZeroDiff]] sets `endLine` equal to `startLine` so enclosing `@lat:` references still match.

## Non source files and deleted files are ignored

[[src/cli/fork-stop-impact.ts#parseUnifiedZeroDiff]] skips `+++ /dev/null` deletions and files whose extension is not in [[packages/core/src/source-formats.ts#SOURCE_FILE_EXTENSIONS]].

## Exact line match to code reference resolves canonical section

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] resolves the canonical section id when a modified hunk directly overlaps an in-file `@lat:` reference.

## Code reference within fifteen lines resolves canonical section

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] matches `@lat:` references located within 15 lines above or below a modified hunk range.

## Nearest preceding code reference resolves when outside window

When no `@lat:` reference lies within 15 lines of a hunk, [[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] falls back to the nearest preceding `@lat:` comment in the same file.

## Wiki reference targeting modified file resolves source section

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] includes `lat.md/` sections whose outgoing wiki links target a modified source file or symbol.

## Section results are deduplicated sorted and capped at ten

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] deduplicates resolved section ids, sorts them alphabetically, and caps the returned list at 10 entries.

## Untrusted section identifiers are sanitized

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] passes every resolved section id through [[packages/core/src/untrusted.ts#cleanUntrustedId]] before returning.

## Git execution failure fails open with empty array

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] catches git subprocess errors or non-git directories and returns an empty array.

## Stop hook formats impacted sections receipt when sync needed

When `needsSync` is true and [[src/cli/hook.ts#getStopStatus]] populates `impactedSections`, [[src/cli/hook.ts#formatStopReason]] appends the `[[section]]` list to the stop message.
