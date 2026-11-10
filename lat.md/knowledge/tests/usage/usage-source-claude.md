---
lat:
  require-code-mention: true
---

# Usage Source Claude

Tests in `tests/usage-source-claude.test.ts` for the Claude Code session reader in `src/fork/usage/sources/claude.ts`, run against synthetic transcripts in `tests/fixtures/usage/claude/`.

## Discovery finds repo and worktree transcripts

Discovery lists the main and subagent transcripts stored under the project directory of the repo root, and returns none for a root Claude Code never ran in.

## Discovery drops another project's transcripts

Paths such as `/x/my-app` and `/x/my.app` share one Claude Code project directory. Discovery keeps a transcript only when its recorded cwd belongs to the project; a transcript with no cwd is kept.

## Discovery closes every transcript it opens

Discovery reads a transcript's head to find its cwd. Repeated discovery of a transcript larger than one read chunk leaves no file descriptor open.

## Subagent events name their parent session

A subagent transcript yields events whose session id is the agent's own and whose `parent_session_id` is the session that launched it, so aggregation can roll them up.

## Session lifecycle and name

A read from offset zero opens with a session start, carries the session title as a session name, and closes with a session end at the last timestamp.

Records such as `mode` and `last-prompt` have no timestamp. A line before the first timestamp of a read takes that timestamp, so the session start is never 1970. A read with no timestamp at all emits nothing and leaves the checkpoint where it was, so a later read emits the session start once, with a real time.

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

A Glob only lists file names, so it is never a bypass read, the same as pi's `ls`, OpenCode's `glob` and Antigravity's `find_by_name`.

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

## A blocked shell call records only the shell call

An errored tool result with no `Exit code N` prefix, such as a PreToolUse hook block or a permission denial, means the command never ran.

The shell tool call is still recorded, with exit code null and reason `not_captured`, but no bd command, edit or bypass read is.

## Message groups are never split

The lines of one assistant message are read together or not at all, so a message split by a read boundary yields one token usage event.

The reader holds back the last message until a user or system line follows it, unless its `stop_reason` is `end_turn`: a finished subagent transcript ends on that message with nothing after it.

Parallel tool calls can put a tool result between two lines of one message, so a read can still stop inside a message. The token usage event id therefore comes from the message id, not the line offset: a later read that sees the same message again emits the same id, and the usage state keeps one event.

Claude Code writes one line per content block, and early lines carry a partial streaming output count. The token usage event takes the usage of the last line of its message in the read, with that line's timestamp. A later read that sees more of the message gives a later ts, so its final count replaces the partial one in the usage state.

## Copied history counts once

A subagent transcript that begins with a copy of another agent's messages adds no token usage or tool call events a second time.

The copy has the same message ids, timestamps and tool_use blocks. Event ids for token usage come from the message id, and ids for tool calls, bypass reads and bd commands come from the tool_use id and a slot within that call. Neither includes the transcript path, so the usage state keeps each copied event once. Session start, end, name and model events stay path based.

## A failed edit is not an edit

An Edit, Write, MultiEdit or NotebookEdit whose result is an error, such as "String to replace not found" or a permission denial, yields no edit event: it changed nothing.

## An errored Read or Grep is not a bypass read

A Read or Grep whose result is an error, such as a hook block or a permission denial, yields its tool call but no bypass read event: it read nothing.

## Shell parsing is shared by the readers

`src/fork/usage/sources/shell-parse.ts` holds the agent-neutral shell parsing: command splitting, write paths, bypass-read arguments and bd ids. A bd id prefix may contain hyphens (`my-app-3x9`), since `bd init` names it after the directory.

A backslash before a newline outside single quotes is a line continuation and leaves nothing behind, so `bd \<newline> close lat-1` closes `lat-1`.

An in-place sed writes only its file operands. The first operand is the script unless `-e`, `-f` or `--expression` carries it, and the empty backup suffix of macOS `sed -i ''` is not an operand.

A `#` that starts a word outside quotes begins a comment, and the parser ignores the rest of that line, so `bd close lat-1  # lat-2 is next` closes only `lat-1`.

The bd verb is found after bd's global flags: `bd --sandbox --actor x update a-1 --claim` claims `a-1`. `--actor`, `--db` and `--dir` take the next word as their value; other leading flags take none. `--sandbox` and `--no-daemon` take no value anywhere, so `bd close --no-daemon lat-1` closes `lat-1`.

A bypass read takes file arguments only: it skips the pattern or script of grep, egrep, fgrep, rg, `git grep`, sed and awk unless `-e`, `-f`, `--regexp`, `--file` or `--expression` carries it, and for find it takes only the start paths before the first expression argument.

`git grep` is found after git's global options, such as `-C <dir>`, `-c <name=value>`, `--git-dir`, `--work-tree`, `--no-pager` and `-P`. A relative target is joined onto the `-C` directory, so `git -C /x grep foo lat.md` reads `/x/lat.md`; the readers then resolve relative paths against the session directory as usual. A `git grep` with no path searches the whole `-C` directory, so `git -C lat.md grep -n foo` reads `lat.md`.

Tests in `tests/usage-shell-parse.test.ts` call it directly; the Claude reader tests cover it through transcripts.

## Unfinished tool calls wait for their result

A tool call with no result yet is held back and the checkpoint stays before it, so a later read pairs it with its result.

## Unreadable store returns a reason

A missing transcript returns no events and the reason `transcript_expired`, and a path that cannot be read as a file returns `not_captured`. Neither throws.
