---
lat:
  require-code-mention: true
---

# Usage Source OpenCode

Tests in `tests/usage-source-opencode.test.ts` for the OpenCode reader in `src/fork/usage/sources/opencode.ts`, run against synthetic rows in `tests/fixtures/usage/opencode/main.json`.

Each test loads the `session`, `message` and `part` rows into a fresh SQLite file.

The format is the OpenCode SQLite store at `opencode/opencode.db` under `XDG_DATA_HOME`, else `~/.local/share`, observed with OpenCode 1.16.2 on 2026-11-08. The reader opens it read-only through `node:sqlite` and closes it after every call, so it never writes to the store or holds a lock on it.

## Session paths and the checkpoint cursor

A session path is the database path, a `#`, and the session id, because one database holds every session.

A session path is not a real file, so the change files of a session are the database and its `-wal` file. SQLite in WAL mode writes to the `-wal` file first, so the database alone can stay unchanged.

Event ids hash that path with the creation time in milliseconds of the message that produced the event, plus the event kind and its index within that message.

The checkpoint offset is also a message creation time: the first message not yet read. Messages at or after it are unread. A tail assistant message that has not completed is held back whole, so its tokens and tool calls are counted once, when it finishes.

## Discovery matches sessions by directory

Discovery lists the sessions whose directory is inside the repo root or one of its worktrees, including subagent sessions. Sessions started elsewhere are left out. A missing database discovers nothing.

## Session lifecycle, name and model

A read from offset zero opens with a session start taken from the session row, carries the model whenever it changes and carries the session title unless it is the default placeholder.

The session name has the session row's `time_updated` as its ts, so a later rename replaces the stored name. It closes with a session end at the last message time.

## Subagent sessions name their parent

Every event of a session that has a parent id carries it as `parent_session_id`. Top-level sessions carry none.

## Edit tools yield edit events

OpenCode's `edit` and `write` tools, and each file named by an `apply_patch` call, yield tool calls with action `edit` and a path relative to the worktree root, or absolute when outside it. A call that failed yields none.

## Shell calls carry command and exit code

A `bash` call yields a shell tool call with its command text. The exit code is the one OpenCode records in the call metadata. A call that did not complete, was rejected, or recorded no exit code has a null exit code with reason `not_captured`.

## Reads and searches

A `read` call yields a tool call with action `read`. `grep` and `glob` yield action `search` with their `path` argument, or null when they search the session directory.

## Lat commands appear as shell calls

A `lat search` run through `bash` is a shell tool call whose command text names the lat command.

## Bypass reads target the knowledge directory

A `read` or `grep` aimed at the worktree's `lat.md/` directory, and a shell reader such as `cat` aimed there, add a bypass read event. A shell call resolves relative paths against its `workdir`.

## An errored read or grep is not a bypass read

A read or grep part aimed at `lat.md/` whose state is not `completed`, such as an `error` state for a missing file, yields its tool call but no bypass read event: it read nothing. A shell reader such as `cat` still counts.

## Beads claim and close carry issue ids

`bd update <id> --claim` yields a claim event and `bd close <ids>` one close event per issue id. Flag values such as `--reason no-action` are never issue ids. A command that was rejected or failed yields none.

## Token usage splits the cache

A completed assistant message yields one token usage event with input, output, reasoning, cache read and cache write counts. The cost OpenCode records for the message is carried as `reported_cost_usd`. A message with no tokens yields none.

## A counter the transcript leaves out is unknown

A token count the message leaves out is null with the reason `unsupported_by_agent`. An explicit 0 stays 0.

## Shell writes add edit events

A shell command that redirects output, or runs `tee`, `sed -i`, `cp` or `mv`, adds an edit event with null bytes beside its shell record.

## Resume from a checkpoint

Reading from the returned checkpoint yields only new events, with the same event ids as one full read.

A read that stops inside an unfinished message resumes at that message and counts its tokens once.

## Unreadable store returns a reason

A missing database returns no events and the reason `transcript_expired`. A file that is not a database, or a session id that has no row, returns `not_captured`. Neither throws.
