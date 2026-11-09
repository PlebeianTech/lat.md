---
lat:
  require-code-mention: true
---

# Usage Source Claude

Tests in `tests/usage-source-claude.test.ts` for the Claude Code session reader in `src/fork/usage/sources/claude.ts`, run against synthetic transcripts in `tests/fixtures/usage/claude/`.

## Discovery finds repo and worktree transcripts

Discovery lists the main and subagent transcripts stored under the project directory of the repo root, and returns none for a root Claude Code never ran in.

## Subagent events name their parent session

A subagent transcript yields events whose session id is the agent's own and whose `parent_session_id` is the session that launched it, so aggregation can roll them up.

## Session lifecycle and name

A read from offset zero opens with a session start, carries the session title as a session name, and closes with a session end at the last timestamp.

## Edit tools yield edit events

Edit, Write and MultiEdit each yield a tool call with action `edit` and the edited path, relative to the worktree root. A shell command that writes a file with a redirect also adds an edit of that file.

## Tool paths are worktree relative

Paths inside the worktree become POSIX paths relative to its root; a path outside stays absolute. Read is `read`, Grep and Glob are `search`.

## Shell calls carry command and exit code

A Bash call yields a shell tool call with its command text. The exit code is read from the failed result; a result without an error flag is zero, and a call with no result is null with reason `not_captured`.

## Lat commands appear as shell calls

A `lat search` run through Bash is a shell tool call whose command text names the lat command.

## Bypass reads target the knowledge directory

A Read, Grep or shell reader aimed at the `lat.md/` directory of the worktree adds a bypass read event. The same tool aimed elsewhere does not.

## Beads claim and close carry issue ids

`bd update <id> --claim` yields a claim event and `bd close <ids>` one close event per issue id, even behind an environment prefix.

## Token usage splits the cache

An assistant message yields one token usage event with input, output, cache read, cache write and reasoning counts. A message split across several lines counts once.

## A counter the transcript leaves out is unknown

A token count the message leaves out, such as `output_tokens_details` in older transcripts, is null with the reason `unsupported_by_agent`. An explicit 0 stays 0.

## Resume from a checkpoint

Reading from the returned checkpoint yields only new events, and the two reads together equal one full read with no repeats.

## Redirecting shell calls keep their shell record

A shell command that writes files still yields its shell tool call, with command and exit code, and bypass detection still runs; the edit events come in addition.

## Heredoc bodies never invent writes

A greater-than sign, quote or `<<-` delimiter inside a heredoc, including one in a `$(...)` commit message, adds no edit event and hides no later command.

## Beads ids come from positional arguments

Flag values such as `--reason no-action` are never issue ids, and `--claim` counts wherever it sits among the flags.

## Background shell calls have no exit code

A shell call run in the background returns at once, so its exit code is null with reason `not_captured`.

## Message groups are never split

The lines of one assistant message are read together or not at all, so a message split by a read boundary yields one token usage event.

## Shell parsing is shared by the readers

`src/fork/usage/sources/shell-parse.ts` holds the agent-neutral shell parsing: command splitting, write paths, bypass-read arguments and bd ids.

Tests in `tests/usage-shell-parse.test.ts` call it directly; the Claude reader tests cover it through transcripts.

## Unfinished tool calls wait for their result

A tool call with no result yet is held back and the checkpoint stays before it, so a later read pairs it with its result.

## Unreadable store returns a reason

A missing transcript returns no events and the reason `transcript_expired`, and a path that cannot be read as a file returns `not_captured`. Neither throws.
