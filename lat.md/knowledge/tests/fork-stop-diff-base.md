---
lat:
  require-code-mention: true
---

# Fork Stop Diff Base

Tests in [[tests/fork-stop-diff-base.test.ts]] for [[src/fork/stop-diff-base.ts#stopDiffBase]], which picks the revision that [[cli#hook#Stop]] measures changes from.

Each git test copies the `hook-clean` case into a temporary repository with a committed one-line `src/app.ts`. The tests with an upstream push `main` to a bare repository in the same temporary directory, so no test reaches the network.

## Committed doc changes still count

With an upstream, a 100-line change to `src/app.ts` stays uncommitted and an edit to `lat.md/feature.md` is committed. [[src/cli/hook.ts#analyzeDiff]] reports at least 100 code lines and more than zero `lat.md/` lines.

## Committed code changes still need a sync

With an upstream, a 100-line change to `src/app.ts` is committed and the tree is clean. [[src/cli/hook.ts#getStopStatus]] reports at least 100 code lines and `needsSync` true.

## A branch without an upstream diffs against HEAD

Without an upstream, the base is `HEAD`. After the doc commit, the churn is 101 code lines and zero `lat.md/` lines. After the code commit too, the churn is zero code lines and `needsSync` is false.

## Outside a git repository there is no churn

In a directory that is not a git repository, the base is `HEAD` and the churn is zero code lines and zero `lat.md/` lines.

## Output that is not an object id falls back to HEAD

A fake `git` first on `PATH` prints numstat text for every command. The base is `HEAD`, so that text never becomes part of a git command. The test does not run on Windows.
