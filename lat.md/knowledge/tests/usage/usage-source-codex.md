---
lat:
  require-code-mention: true
---

# Usage Source Codex

Tests in `tests/usage-source-codex.test.ts` for the OpenAI Codex session reader in `src/fork/usage/sources/codex.ts`, run against synthetic rollout files in `tests/fixtures/usage/codex/`. The format was observed on Codex CLI 0.153 to 0.160.

## Discovery matches sessions by working directory

Discovery lists the rollout files under `sessions/YYYY/MM/DD/` of the Codex home whose first `session_meta` names a working directory inside the repo root or one of its worktrees. Sessions started elsewhere, and unreadable files, are left out.

## Subagent events name their parent session

A subagent rollout yields events whose session id is its own thread id and whose `parent_session_id` is the thread that spawned it. The history replayed from the parent at the head of the file yields no events.

## Session lifecycle, name and model

A read from offset zero opens with a session start, carries the model of each turn when it changes and the thread name from `session_index.jsonl`, and closes with a session end at the last timestamp.

## Patches yield edit events

A `FileChange` item yields one tool call with action `edit` for every path it names, whether added, updated or deleted. Paths inside the worktree are POSIX paths relative to its root; a path outside stays absolute.

## Shell calls carry command and exit code

A `CommandExecution` item yields a shell tool call with the script that ran and its exit code. A missing or negative exit code is null with reason `not_captured`, never zero.

## Reads and searches come from parsed commands

Codex has no read tool. The reader takes `read` and `search` actions from the item's `parsed_cmd` classification, and an `ImageView` item is a `read`.

## Lat commands appear as shell calls

A `lat search` run in the shell is a shell tool call whose command text names the lat command.

## Bypass reads target the knowledge directory

A shell reader aimed at the `lat.md/` directory of the worktree adds a bypass read event with the output size. The same command aimed elsewhere does not.

## Beads claim and close carry issue ids

`bd update <id> --claim` yields a claim event and `bd close <ids>` one close event per issue id. Flag values such as `--reason no-action` are never issue ids. A failed command yields none.

## Token usage splits the cache

A `token_usage_record` yields one token usage event. Input counts only uncached tokens, because Codex reports cached tokens inside its input total. The same response id seen twice counts once.

## A counter the transcript leaves out is unknown

A token count the record leaves out is null with the reason `unsupported_by_agent`. An explicit 0 stays 0.

Input is null when the input total, the cached count or the cache-write count is missing, because the uncached input cannot be worked out without all three.

## Shell writes add edit events

A shell command that redirects output, or runs `tee`, `sed -i`, `cp` or `mv`, adds an edit event beside its shell record. A heredoc body never invents a write.

## Resume from a checkpoint

Reading from the returned checkpoint yields only new events, and the two reads together equal one full read with no repeats. A final line without its newline is left for the next read.

## Unreadable store returns a reason

A missing rollout file returns no events and the reason `transcript_expired`, and a path that cannot be read as a file returns `not_captured`. A missing Codex home discovers nothing. Neither throws.

## Worktree helpers find roots

`worktreeRoots` lists a repo root and its linked worktrees, or the root alone outside a repository. `findWorktreeRoot` returns the nearest ancestor holding `.git`, or the path itself.
