---
lat:
  require-code-mention: true
---

# Usage CLI

Tests in `tests/usage-cli.test.ts` for [[src/fork/usage/usage-cli.ts]].

They build a temporary project with a `lat.md` directory, write usage events and fake session events into it, and run the command on a fresh commander program with `--dir`. The aggregator takes fake session sources and a fake bd reader, so no test reads the real machine.

## Enable and disable toggle the usage directory

`lat usage enable` creates `<root>/.lat/usage/` with its `.gitignore`. `lat usage disable` takes it away, so `usageEnabled` turns false. Both are safe to run twice.

## Disable keeps the recorded events

`lat usage disable` renames `.lat/usage` to `.lat/usage.disabled`, so the events and the ignore file survive. `lat usage enable` renames it back.

If `.lat/usage.disabled` already exists, disable refuses with a message and changes nothing. If a rename fails, the command prints both paths, sets exit code 1 and moves nothing. If both directories exist, enable changes nothing. Both commands print what they did and the real state; with `LAT_USAGE=1` disable says tracking is off for the project but the variable still enables it.

## Enable refuses a symlinked usage directory

When `.lat`, `.lat/usage` or `.lat/usage.disabled` is a symlink, `lat usage enable` prints one line naming it, sets exit code 1 and writes nothing where it points.

## Disable refuses a symlinked usage directory

When `.lat`, `.lat/usage` or `.lat/usage.disabled` is a symlink, `lat usage disable` prints one line naming it, sets exit code 1 and moves nothing where it points.

## Each filter narrows the output

`--agent`, `--session`, `--issue` and `--since` each narrow the commands counted. `--issue` of an epic includes its descendants. `--since` becomes the `from` filter.

## Filters go through parseUsageFilters

The command passes its flags to `parseUsageFilters` and has no parser of its own. An invalid `--since` date fails the command with the parser's message.

## The json output is the aggregate summary

`--json` prints the whole `UsageSummary`, with `extensions.savings` and the graph snapshot extension (`extensions.knowledge`), and it carries `schema_version`.

## The text output shows unknown as unknown

An unknown token total or net saving prints as `unknown`, with its reason, and never as 0.

## The text output shows savings as a labelled range

Savings print as a low to high range with the point estimate, the `method_version` and the words `correlation, not cause`.

## Issue rows are not summed

The issue lines carry a note that the rows overlap and are not additive. The command prints no total of the issue rows.
