---
lat:
  require-code-mention: true
---

# Usage Tracked Usage

Tests in `tests/usage-tracked-usage.test.ts` for [[src/fork/usage/tracked-usage.ts]], which follows [[usage-analytics#Usage Analytics#Opt-in and the usage directory]].

Each test builds a real temporary git repository, stages a file under `.lat/usage` with `git add -f`, and captures stdout and stderr. Nothing mocks git. The aggregator takes no session sources and a fake bd reader.

## lat usage warns when git tracks usage files

With a tracked file under `.lat/usage`, `lat usage` prints one warning on stderr that names the fix `git rm -r --cached .lat/usage`. Stdout holds no warning, and `--json` still parses. The warning names no file.

## No warning when nothing is tracked or git cannot say

When git lists nothing, when the root is not in a repository, and when git is not installed, `lat usage` prints nothing on stderr and still prints its totals. Git's own error text never reaches the terminal.

## lat ui warns once per project root

When the live state of a project root starts, the dashboard server prints the same warning on stderr. Later requests and a restart of that root's live state print nothing more.

## Enable adds the usage directory to .gitignore

`lat usage enable` creates `<root>/.gitignore` when missing, or appends a short comment line and `.lat/usage/`. It does this on the already-enabled path too, and once for two runs.

Existing lines stay. Enable adds a newline first when the last line has none.

## Enable skips an existing ignore line

A `.gitignore` line that already ignores the directory leaves the file unchanged. These lines count: `.lat/usage`, `.lat/usage/`, the same with a leading slash, `.lat/` and `/.lat/`.

Windows line endings do not matter. A commented-out line or `.lat/usage-old/` does not count.

## Enable never writes through a symlinked .gitignore

When `.gitignore` is a symlink, to an existing file or to a missing one, enable leaves it and the target alone and prints one line naming the link. When `.gitignore` is a directory, enable prints a note and still finishes. Exit code stays 0.
