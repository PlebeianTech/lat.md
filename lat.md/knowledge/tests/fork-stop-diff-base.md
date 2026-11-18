---
lat:
  require-code-mention: true
---

# Fork Stop Diff Base

Tests in [[tests/fork-stop-diff-base.test.ts]] for [[src/fork/stop-diff-base.ts#stopDiffBase]], which picks the revision that [[cli#hook#Stop]] measures changes from.

Each git test copies the `hook-clean` case into a temporary repository with a committed one-line `src/app.ts`. The tests with an upstream push `main` to a bare repository in the same temporary directory, so no test reaches the network.

## Committed doc changes still count

With an upstream, a 100-line change to `src/app.ts` stays uncommitted and an edit to `lat.md/feature.md` is committed. [[src/cli/hook.ts#analyzeDiff]] reports at least 100 code lines and more than zero `lat.md/` lines.

## Committed doc changes still count after a fetch

After a doc commit, a fetch brings in an unrelated commit, so the upstream is no longer an ancestor of `HEAD`. [[src/cli/hook.ts#analyzeDiff]] still reports more than zero `lat.md/` lines.

The code change is uncommitted, as in the test above. A second clone pushes the unrelated commit.

## Committed code changes still need a sync

With an upstream, a 100-line change to `src/app.ts` is committed and the tree is clean. [[src/cli/hook.ts#getStopStatus]] reports at least 100 code lines and `needsSync` true.

## Code merged from another branch does not count

With an upstream, a 100-line change to `src/app.ts` is committed on a second branch and merged into `main` with a merge commit. The agent changes nothing. [[src/cli/hook.ts#analyzeDiff]] reports zero code lines, and [[src/cli/hook.ts#getStopStatus]] reports `needsSync` false.

## A branch that diverged from its upstream diffs against the merge base

With an upstream, a code commit is pushed and then amended, as a rebase would rewrite it. The branch and its upstream have diverged, and the base is their merge base: the commit before the code commit.

## A branch without an upstream diffs against HEAD

Without an upstream, the base is `HEAD`. After the doc commit, the churn is 101 code lines and zero `lat.md/` lines. After the code commit too, the churn is zero code lines and `needsSync` is false.

## Outside a git repository there is no churn

In a directory that is not a git repository, the base is `HEAD` and the churn is zero code lines and zero `lat.md/` lines.

## Output that is not an object id falls back to HEAD

A fake `git` first on `PATH` prints numstat text for every command. The base is `HEAD`, so that text never becomes part of a git command. The test does not run on Windows.
