---
lat:
  require-code-mention: true
---

# Usage Findings Stale Sections

Tests in `tests/usage-findings-stale-sections.test.ts` for the stale-hot-section detector (`src/fork/usage/findings-stale-sections.ts`).

Each test builds a temporary git repository whose commits carry controlled author and committer dates, then runs the detector's `prepare` and `detect`. None asserts on elapsed time.

## A referenced file newer than its section is stale

A section in the top 20 by reads whose code-ref file was last committed after the section's Markdown file yields a `stale-hot-section` finding. Its subject is the section id.

## A section that links a source file goes stale with it

A section whose prose links a source file, such as `[[src/x.ts#fn]]`, counts that file as referenced. The `#symbol` suffix is removed and git is never given it, and a file linked twice is read once.

## A project in a repository subdirectory is checked

When the project root is a subdirectory of the git repository, paths from `git log` are read relative to that root, so a newer referenced file still makes its section stale.

## A referenced file older than its section is not stale

A section whose referenced files were all committed before its Markdown file yields no finding.

## A section outside the top 20 is ignored

A stale section ranked below the 20 most-read sections yields no finding, even though its referenced file is newer.

## A second call at the same git head does not run git again

`prepare` reads every file's last commit time in one `git log` pass. A second `prepare` at an unchanged git head reuses the cached times and runs no `git log`. A new commit makes the next `prepare` run it again.

## A missing repository fails prepare

`prepare` on a root that is not a git repository throws, so `findingsFor` reports the error under the detector name and the other detectors still run.
