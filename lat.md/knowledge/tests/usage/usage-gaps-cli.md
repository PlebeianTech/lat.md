---
lat:
  require-code-mention: true
---

# Usage Gaps CLI

Tests in `tests/usage-gaps-cli.test.ts` for `src/fork/usage/usage-gaps-cli.ts`, the `lat usage gaps` subcommand.

They build a temporary project, write usage events, fake session events and a fake knowledge contribution into it, and run the command on a fresh commander program with `--dir`, the same way the `lat usage` tests do.

## Text output lists each finding kind

Each finding prints on one line with its kind, subject, count and sessions affected. An empty search with a closest section adds that section's id. A never-read section and a bypassed file print the same way.

## The json output holds the full findings

`--json` prints the same body as `GET /api/usage/findings`: `schema_version`, `findings` with every field of the finding record, and `errors`.

## Each filter narrows the gaps

`--agent`, `--session`, `--issue` and `--since` each narrow the findings. `--issue` of an epic includes its descendants. `--since` becomes the `from` filter.

## An empty result says so in one line

When no finding matches, the command prints one line saying no gaps were found for the filters, and nothing else.

## Long lists and detector errors stay short

The text output shows the first twenty findings and counts the rest. A detector that failed prints one line naming it and its message, so a failure is never read as a clean result.

## A search miss names its expected section

A `search-miss` line ends with `expected: <section id>`, so two misses on the same query for different sections read differently.

## Text output strips control characters

Subjects, section titles, section ids and detector errors come from transcripts and repository files. The text output strips their control characters, so an escape sequence in a file name prints as plain text and never reaches the terminal.
