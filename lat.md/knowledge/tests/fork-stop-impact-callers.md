---
lat:
  require-code-mention: true
---

# Fork Stop Impact Callers

Tests in [[tests/fork-stop-impact-callers.test.ts]] for the caller sections that [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] adds to [[cli#hook#Stop]]. Each test registers a fixture callers provider through a temporary `XDG_CONFIG_HOME` and changes only `bar` in a temporary git repository, where `foo` calls `bar`.

## Caller section is listed after the direct list

When the provider reports `foo` as a caller of the changed `bar`, [[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] returns the section linked to `foo` as `callerSections`, and [[src/cli/hook.ts#formatStopReason]] prints it in a `Sections linked to callers of modified code:` line.

## Only changed symbols are sent to the provider

The provider request names the symbols whose line ranges overlap a changed range, here `bar` and not the untouched function below it, and asks for depth 1.

## Without a provider the Stop reason is unchanged

With no callers provider configured, `callerSections` is empty and the Stop reason has no caller line. With one, the reason is the same text plus the caller line.

## A failing provider leaves the Stop reason unchanged

When the provider exits with an error, `callerSections` is empty and the Stop reason equals the one without a provider.

## Reviewed direct sections skip the lookup and keep the reminder cleared

When every direct linked section is reviewed, the provider is never run, `callerSections` is empty, and [[src/cli/hook.ts#getStopStatus]] still clears `needsSync`.

## Caller sections never repeat an unreviewed direct section

A section that is both directly linked and linked to a caller appears only in `unreviewedSections`. The lookup still runs beside a non-empty direct list, `linkedSectionCount` counts only direct sections, and the caller line follows the direct line.

## An edited caller section is not listed

A caller section whose lines changed in the working tree is left out of `callerSections`, by the same rule that drops reviewed direct sections.

## Seven caller sections print five

[[src/cli/fork-stop-impact.ts#findUnreviewedSectionsForDiff]] sorts the caller sections and caps them at five, so seven linked sections give a caller line with five.

## The Antigravity Stop handler carries the caller line

[[src/fork/antigravity-hook.ts#handleAntigravityStop]] returns a reason that holds the same caller line for the same fixture.
