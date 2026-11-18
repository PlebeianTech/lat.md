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

## Untouched linked section is not reviewed

In a temporary git repository, a code change next to an `@lat:` comment links one section. [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] counts one linked section and lists it as not reviewed, because its lines did not change.

## Rewritten linked section clears the reminder

After the linked section's paragraph is rewritten (2 changed doc lines), [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] still counts one linked section but lists none. [[src/cli/hook.ts#getStopStatus]] on a fresh repository in the same state returns `needsSync` false, although 2 doc lines are below the 5 percent ratio.

## Only unreviewed linked sections are listed

With two linked sections and one of them rewritten, [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] lists only the other one.

## Ten section cap applies after reviewed sections are removed

With twelve linked sections and the alphabetically first ten rewritten, [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] lists the remaining two. The cap of ten applies after the reviewed sections are removed.

## Section in an untracked doc file counts as reviewed

A linked section that lives in an untracked file under `lat.md/` never appears in `git diff`. [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] counts it as reviewed.

## Code change without linked sections keeps the ratio rule

When the code change links no section, [[src/cli/hook.ts#getStopStatus]] keeps the line ratio rule: 400 code lines against 2 doc lines still sets `needsSync`, with an empty section list.
