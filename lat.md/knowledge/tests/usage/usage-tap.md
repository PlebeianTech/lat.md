---
lat:
  require-code-mention: true
---

# Usage Tap

Tests in `tests/usage-writer.test.ts` and `tests/usage-cli-tap.test.ts` for the JSONL writer, agent detection and the commander tap under `src/fork/usage/`.

## Events append to a monthly file

`writeUsageEvent` appends one JSON line per event with a synchronous append to `.lat/usage/events-YYYY-MM.jsonl`, the month taken from the event's UTC timestamp.

## The usage directory ignores itself

The first write creates `.lat/usage/.gitignore` holding a single asterisk, so event files never reach version control. Later writes leave it alone.

## Lines stay under 4 KB

Every line, newline included, stays under 4096 bytes so that appends from concurrent processes stay atomic. The writer shortens the query to fit.

## A failing write is silent

A read-only `.lat/usage/` makes the writer return without throwing and without a partial line. The tap must never change a command's output or exit code.

## Concurrent writers never interleave

Twenty processes appending large events at once leave only whole, parseable lines, one per event.

## Tracking off writes nothing

When neither `.lat/usage/` exists nor `LAT_USAGE=1` is set, a command makes no file system write: no directory, no `.gitignore`, no event file.

## One event per command

With tracking on, each command appends exactly one valid event. `search`, `section`, `expand`, `refs` and `hook` are covered.

The event is written from the process exit listener because commands call `process.exit` on failure and skip any post-action hook. Hook commands record the surface `hook` and the caller `hook-injected`. `lat mcp` is not tapped here because the MCP server records its own calls.

## A failed command still records

A `section` lookup with no match still writes an event, with `exit_code` 1 and `error_class` `nonzero_exit`.

## Search events carry context

A `search` event holds the query, the git head, the worktree, a positive duration and the lat version. With no agent variable set the caller is `human` and the agent and session id are null.

## Agent detection

The agent and session id come from the calling agent's environment variables.

Claude Code (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`), Codex (`CODEX_THREAD_ID`), Antigravity (`ANTIGRAVITY_CONVERSATION_ID`), pi (`PI_CODING_AGENT`, no session id) and OpenCode (`OPENCODE`, no session id). Where no variable exists the value is null with the reason `unsupported_by_agent`. A detected agent makes the caller `agent`.

## A read-only usage directory changes nothing

With a read-only `.lat/usage/`, a command prints the same output and exits with the same code as with tracking off.

## Registration

`registerForkCli` installs the tap on a commander program, so one registration line in the CLI entry point covers every command, including ones later issues add.

## Unknown fields carry a reason

Fields the tap cannot know, such as `result_count` for a command with no output parser, are null with an entry in `unknown_reasons`, never zero. Fields that do not apply are null without one.

## No project root means no tap

When no `lat.md` directory is found, the tap records nothing, even with `LAT_USAGE=1`, and creates no `.lat/` directory.

## The tap never throws

A failure while locating the root or building the event leaves the command's output and exit code unchanged.

## Git state is read from files

The head and worktree come from `.git` files, never a subprocess. A `.git` file pointing to a worktree is followed, and a branch resolves through its loose ref file, then `packed-refs`. A detached head is read directly. On failure the value is null.
