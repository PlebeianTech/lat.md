---
lat:
  require-code-mention: true
---

# Usage Source pi

Tests in `tests/usage-source-pi.test.ts` for the pi session reader in `src/fork/usage/sources/pi.ts`, run against synthetic session files in `tests/fixtures/usage/pi/`.

The format is pi session format version 3, observed on this machine on 2026-11-08; the sessions do not record the pi release. The agent directory is `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.

## Discovery matches sessions by working directory

Discovery lists the `*.jsonl` files one level below `sessions/` whose header line names a working directory inside the repo root or one of its worktrees. Sessions started elsewhere, and unreadable files, are left out.

## Session lifecycle, name and model

A read from offset zero opens with a session start taken from the header, carries the model whenever it changes, carries each session name once, and closes with a session end at the last record time.

## Edit and write tools yield edit events

A pi `edit` or `write` call yields a tool call with action `edit` and its path, relative to the worktree root when inside it and absolute otherwise. A call without a path yields nothing.

## Shell calls carry command and exit code

A `bash` call yields a shell tool call with its command text. The exit code comes from the result: a successful result is zero, `Command exited with code N` is N, and a timeout, abort or missing result is null with reason `not_captured`.

## Reads and extension tools

A `read` call yields a tool call with action `read`. Tools pi does not own, such as `lat_search`, yield nothing; the lat CLI records those calls itself.

## Grep find and ls are searches

pi's `grep`, `find` and `ls` tools yield tool calls with action `search` and their `path` argument, normalized like any other path, or null when pi searches its working directory.

`ls` only lists names, so it is a search and never a bypass read; `grep` and `find` aimed at `lat.md/` are.

## Lat commands appear as shell calls

A `lat search` run through `bash` is a shell tool call whose command text names the lat command.

## Bypass reads target the knowledge directory

A `read` of a file under the worktree's `lat.md/` directory, and a shell reader aimed there, add a bypass read event with the result size. The same call aimed elsewhere does not.

## Beads claim and close carry issue ids

`bd update <id> --claim` yields a claim event and `bd close <ids>` one close event per issue id. Flag values such as `--reason no-action` are never issue ids. A command that failed yields none.

## Token usage splits the cache

An assistant message yields one token usage event. Input counts only uncached tokens, because pi reports cache reads and writes beside it.

A compaction record carries its own usage and yields one too. A message with no tokens, such as an aborted request, yields none. The cost pi reports for the message, in US dollars, is carried as `reported_cost_usd`.

## A counter the transcript leaves out is unknown

A token count the message leaves out is null with the reason `unsupported_by_agent`. An explicit 0 stays 0.

## Shell writes add edit events

A shell command that redirects output, or runs `tee`, `sed -i`, `cp` or `mv`, adds an edit event beside its shell record.

## Resume from a checkpoint

Reading from the returned checkpoint yields only new events, and the two reads together equal one full read with no repeats.

A final line without its newline is left for the next read, and so is a tail assistant message whose tool results have not arrived.

## Unreadable store returns a reason

A missing session file returns no events and the reason `transcript_expired`, and a path that cannot be read as a file returns `not_captured`. A missing agent directory discovers nothing. Neither throws.
