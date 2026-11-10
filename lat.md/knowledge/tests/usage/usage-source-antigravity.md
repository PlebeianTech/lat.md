---
lat:
  require-code-mention: true
---

# Usage Source Antigravity

Tests in `tests/usage-source-antigravity.test.ts` for the Antigravity (agy) reader in `src/fork/usage/sources/antigravity.ts`, run against synthetic transcripts in `tests/fixtures/usage/antigravity/`.

Each test builds a summaries database in a fresh temporary home directory.

The format is the agy store at `~/.gemini/antigravity-cli`, observed with agy language server 1.5.3 on 2026-11-08. Per-turn data comes from `brain/<id>/.system_generated/logs/transcript_full.jsonl`. Session name, project folder and parent come from the `conversation_summaries` table of `conversation_summaries.db`. The reader never writes under `~/.gemini`: it opens a temporary copy of the database, with its `-wal` and `-shm` files, and deletes the copy after the read. The copy is cached by the modification time and size of the database and its `-wal` file, so rows that reach only the log are still seen.

## Session paths and the checkpoint cursor

A session path is the absolute path of the conversation's `transcript_full.jsonl`; the session id is the conversation directory name.

Event ids hash that path with the byte offset of the transcript line that produced the event, plus the event kind and its index within the line. The checkpoint offset is a byte offset: the first line not yet read.

## Discovery matches sessions through the summaries database

Discovery lists the conversations whose workspace folder is inside the repo root or one of its worktrees, including subagents.

Conversations with no workspace or no steps are stubs and are left out. A conversation with no database row is matched through the workspace in `history.jsonl`. A missing store discovers nothing.

## Session lifecycle and name

A read from offset zero opens with a session start at the first transcript row. It closes with a session end at the last row read.

Every read that has new rows carries the conversation title when the database has one, in one fixed slot, so a title written after the first read still arrives and the usage state keeps the latest.

## Subagent conversations are their own sessions

A subagent runs in its own conversation with its own transcript. Every event of such a session carries the database's parent conversation id as `parent_session_id`. Top-level sessions carry none, and the parent's events never include the child's.

## Edit tools yield edit events

The `edit_file`, `write_to_file`, `write_file` and `replace_file_content` tools yield tool calls with action `edit` and a path relative to the worktree root, or absolute when outside it. A call whose result row is an error yields none.

## Shell calls carry command and exit code

A `run_command` call yields a shell tool call with its `CommandLine` and an exit code.

The exit code is read from the result row's `Command exited with code` line. A background command takes the code from the later system message that reports its finish. A background command whose finish is not reported before the next user prompt or within an hour, a truncated result, or an error row has a null exit code with reason `not_captured`.

## Reads and searches

`read_file` and `view_file` yield action `read`. `grep_search`, `find_by_name` and `list_dir` yield action `search` with their search path. Relative paths resolve against the conversation's workspace folder.

## Lat commands appear as shell calls

A `lat search` in `run_command` is a shell tool call whose command text names the lat command. The same words in a user prompt are not usage.

## Bypass reads target the knowledge directory

A read tool or `grep_search` aimed at the worktree's `lat.md/` directory, and a shell reader such as `cat` aimed there, add a bypass read event.

## An errored read or grep is not a bypass read

A `read_file`, `view_file` or `grep_search` call aimed at `lat.md/` whose result row is not `DONE`, such as an `ERROR` row for a missing file, yields its tool call but no bypass read event: it read nothing.

## Beads claim and close carry issue ids

`bd update <id> --claim` yields a claim event and `bd close <ids>` one close event per issue id. Flag values are never issue ids. A command that exited non-zero yields none.

## Token usage splits the cache

Each model turn and each compaction checkpoint row that carries token counts yields one token usage event with input, output and cache read counts.

The store has no cache-write or reasoning count, so both are null with the reason `unsupported_by_agent`. Rows without counts yield none.

## A counter the transcript leaves out is unknown

A token count the row leaves out, such as `cache_read_tokens`, is null with the reason `unsupported_by_agent`, like cache write and reasoning. An explicit 0 stays 0.

## Shell writes add edit events

A shell command that redirects output, or runs `tee`, `sed -i`, `cp` or `mv`, adds an edit event with null bytes beside its shell record.

## Resume from a checkpoint

Reading from the returned checkpoint yields only new events, apart from the session name and end, which every read emits again in their fixed slots.

A model turn whose tool results are not all written yet is held back whole, so its tokens and calls are counted once, when the results arrive.

A turn that stays short of results is released once any other row follows it. It is then emitted once, with a null exit code and reason `not_captured` for shell calls that have no result, and no edit events for calls that have none.

A background command whose finish message is not written yet holds the checkpoint at its turn. Its own events wait; the rest of the turn and later rows are emitted, and the next read emits them again under the same event ids. The finish message, read later, gives the exit code, and a failed command then adds no edit, bypass read or bd event. A read split between the command and its finish gives the same events as one full read.

The next user prompt releases the hold, and so does the command's RUNNING row becoming more than an hour old by the wall clock (or having no readable `created_at`). A released command is emitted with a null exit code and reason `not_captured`, so a session that ends with no finish still emits it. Its events take their own `task-<step>:` slots, so emitting them late does not change the ids of the other calls in the turn.

## Reading never modifies the store

After discovery and a read, every file under the store keeps its modification time, and no temporary copy of the database remains.

## Unreadable store returns a reason

A missing transcript returns no events and the reason `transcript_expired`. A transcript with no database row and no history entry returns its events with the reason `not_captured`. A missing database discovers and reads without throwing.
