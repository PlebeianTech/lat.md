# Usage Analytics

Field reference for the usage event types. It covers every field of UsageEvent and SessionEvent, with unit and derivation. Types live in [[src/fork/usage/schema.ts]].

Lat writes one UsageEvent for each command it runs. Lat also reads agent transcripts and turns them into SessionEvents. This document says what each field holds today.

## Unknown values

A field that lat could not learn is null. It is never zero. Each such null names a reason.

There are three reasons:

- `not_captured`: lat did not record the value.
- `transcript_expired`: the transcript that held the value is gone.
- `unsupported_by_agent`: the agent does not expose the value.

A null can also mean "not applicable". For example, `query` is null for a command that takes no query. A not-applicable null has no reason.

Where a field holds a single value, the reason sits in `unknown_reasons`, keyed by the field name. Where a value is wrapped, the wrapper carries the reason itself. The wrapper is `Captured<T>`: either `{ value }` or `{ value: null, reason }`.

## Usage event

A UsageEvent is one line of `.lat/usage/events-YYYY-MM.jsonl`. It records one lat CLI command, one MCP tool call, or one hook run. The type is [[src/fork/usage/schema.ts#UsageEvent]]. The CLI writer is [[src/fork/usage/cli-tap.ts]]. The MCP writer is [[src/fork/usage/mcp-tap.ts]].

The MCP tap is installed by `registerForkMcp` in [[src/fork/usage/mcp-registration.ts]], which wraps the server's tool registration. Every tool registered after it writes one event per call. The MCP tap fills the same fields from the tool result, with the tool name minus its `lat_` prefix as `command`, `exit_code` 1 when the tool returned an error or threw, and `bytes_out` as the byte length of the result text. It stores ids, counts and byte lengths, never the result text, and it never changes or delays a result.

### Usage event fields

These are the usage event fields. Units are in each entry. A type of `X | null` means null is possible.

- `schema_version` (number): always `1` today. Readers check it before they trust the rest.
- `event_id` (string): a random UUID. The CLI writer makes it when the command ends.
- `ts` (string): ISO 8601 time, in UTC. It is the time the command started.
- `duration_ms` (number): milliseconds from command start to command exit.
- `command` (string): the command name, such as `search`. A hook run records `hook` and its event, such as `hook UserPromptSubmit`.
- `surface` (`cli`, `mcp` or `hook`): where the call came from. A `hook` command gets `hook`. Every MCP tool call gets `mcp`.
- `caller` (`agent`, `human` or `hook-injected`): who ran it. `hook-injected` is a hook run. `agent` means lat detected an agent. Otherwise it is `human`.
- `agent` (string or null): the agent name, such as `claude` or `codex`. Lat reads it from the agent's environment variables. Null has a reason.
- `lat_version` (string): the lat version that wrote the event. It is `unknown` if lat cannot read it.
- `session_id` (string or null): the agent session that ran the command. Null has a reason. Claude Code sets the same `CLAUDE_CODE_SESSION_ID` in a subagent's commands as in its parent's, and nothing else in the environment tells them apart (`CLAUDE_CODE_CHILD_SESSION` is set on every process Claude Code spawns). So a lat command run by a Claude subagent is recorded under the parent session. Attribution makes up for this: when the parent session has no open claim, the event takes the claim of its one subagent that has an open claim at that time.
- `parent_session_id` (string or null): the session that spawned this one. No agent exposes it to the commands it runs, so it is always null with `not_captured`.
- `repo_root` (string): absolute path of the project root.
- `git_head` (string or null): the full commit hash of HEAD, read from `.git` files. Lat does not run git. Null has a reason.
- `worktree` (string or null): absolute path of the git worktree that holds the root. Null has a reason.
- `query` (string or null): the first argument of a command that takes a query. Null for other commands, and always null for `expand`, whose input is a prompt.
- `result_ids` (array of string): ranked section ids. For `lat expand`, the resolved ids. The CLI tap fills it from `lat search` (rank order), `lat expand` and the hook's search results, on exit 0 only. Otherwise it is an empty array.
- `result_count` (number or null): the length of `result_ids`, set whenever the tap fills `result_ids`. Otherwise null, with `not_captured`.
- `section_id` (string or null): the section a command read: the id on the first line of `lat section` output, or the section a hook printed in full. Otherwise null, with `not_captured`. Null without a reason when `found` is false.
- `injected_bytes` (number or null): hook events only. The byte length of all the text a hook gave the agent, summed: `additionalContext`, `permissionDecisionReason`, the Stop hook's `reason`, Cursor's `additional_context` and `followup_message`, and each `ephemeralMessage` of Antigravity's `injectSteps`. It is 0 when the hook printed nothing. Null, with `not_captured`, for other hook output.
- `found` (boolean or null): whether a lookup found its target. Set by `lat section` only: true when a section printed, false when the command failed with none. Otherwise null, with `not_captured`.
- `bytes_out` (number or null): bytes the command wrote to stdout, not stderr. Set for every command except `lat ui` and `lat ui run`, where it would be null with `not_captured`. In practice `lat ui` records no event at all: the tap writes the event when the process emits `exit`, and Node emits no `exit` when a signal ends the process. Ctrl-C always ends `lat ui`, and any command killed by a signal likewise records nothing.
- `exit_code` (number): the process exit code. Zero means success.
- `error_class` (string or null): null when the exit code is zero. Otherwise `nonzero_exit`.
- `unknown_reasons` (object): the reason for each unknown null above. Keys are field names. Values are the three reasons from [[usage-analytics#Usage Analytics#Unknown values]].

The nullable keys are `agent`, `session_id`, `parent_session_id`, `git_head`, `worktree`, `query`, `section_id`, `injected_bytes`, `found`, `result_count`, `bytes_out` and `error_class`. The type `UsageNullableField` lists them.

Every null that is unknown has an entry in `unknown_reasons`. A null that is not applicable has none. `query` and `error_class` are the two that have no entry.

The reader in [[src/fork/usage/ingest.ts]] drops a log line whose `schema_version` is not the current one, or whose fields do not have the types above: a missing field, a number where a string belongs, or a `result_ids` entry that is not a string. It also drops any usage line or session event whose `ts` does not parse or falls outside 2000-01-01 to one day after now. A dropped line never reaches `state.json`. Loading `state.json` applies the same usage line checks again to each stored usage event (code in [[src/fork/usage/validate.ts]]). A stored session event is kept only when its `agent` is a string, its `event` is an object and the event's `ts` is plausible; the shape of each event kind is not checked again. A `state.json` whose top-level maps are not objects starts from an empty state.

## Session event

A SessionEvent is one fact that lat read from an agent transcript. Each source reader in `src/fork/usage/sources/` turns its transcript format into this one shape. The type is [[src/fork/usage/schema.ts#SessionEvent]].

### Session event fields

Every session event has these fields.

- `event_id` (string): 16 hex characters. It is a SHA-256 hash of the source path and the offset. The same line always gets the same id. See `sessionEventId`. The Claude reader hashes the message id for token usage, and the tool_use id with a slot for tool calls, bypass reads and bd commands, so a subagent transcript that copies another's history yields the same ids. The pi reader hashes the entry id and timestamp for the same kinds, so a forked or branched pi session that copies earlier entries yields the same ids.
- `session_id` (string): the session the fact belongs to.
- `parent_session_id` (string, optional): set on every event of a subagent session. It names the session that spawned it. It is absent for a top-level session, where it does not apply.
- `ts` (string): ISO 8601 time of the fact.
- `source` (object): where lat read the fact.
  - `path` (string): the transcript file.
  - `offset` (number): the position in that file.
- `kind` (string): selects the extra fields below.

### Session event kinds

The `kind` field takes one of eight values.

- `session_start`: the session began. No extra fields.
- `session_end`: the session ended. No extra fields.
- `session_name`: adds `name` (string), the session title.
- `model`: adds `model` (string), the model name in use.
- `tool_call`: adds `tool`. See [[usage-analytics#Usage Analytics#Session event#Tool call]].
- `token_usage`: adds `usage`. See [[usage-analytics#Usage Analytics#Session event#Token usage]].
- `bypass_read`: an agent read a file without lat. Adds `path` (string) and `bytes` (number or null). A read or search whose result is an error read nothing, so it yields no `bypass_read`.
- `bd_command`: an agent ran `bd claim` or `bd close`. Adds `verb` (`claim` or `close`) and `issue_id` (string).

### Tool call

The `tool` field of a `tool_call` event. The type is [[src/fork/usage/schema.ts#ToolCall]].

- `name` (string): the agent's tool name.
- `action` (`read`, `edit`, `search` or `shell`): what kind of work the call did. An edit whose result is an error changed nothing, so every reader skips it.
- `path` (string or null): the file touched. It is relative to the worktree, with `/` separators. It is absolute when the file is outside the worktree. See `toWorktreeRelativePath`.
- `bytes` (number or null): the size of the data the call moved. Null when the agent does not say.
- `shell` (object): present when the action is `shell`, and only then.
  - `command` (string): the command text.
  - `exit_code` (Captured number): the exit code, or null with a reason.

The type enforces the link between `action` and `shell`. A `shell` call must have `shell`. Any other call must not.

### Token usage

The `usage` field of a `token_usage` event. The type is [[src/fork/usage/schema.ts#TokenUsage]]. All counters are token counts.

- `input` (number or null): input tokens.
- `output` (number or null): output tokens.
- `cache_read` (number or null): tokens read from the prompt cache.
- `cache_write` (number or null): tokens written to the prompt cache.
- `reasoning` (number or null): reasoning tokens.
- `unknown_reasons` (object, optional): one reason for each null counter. Keys are counter names.
- `reported_cost_usd` (number, optional): cost in US dollars, as the transcript reports it. It is absent when the agent reports none.

A reader sets a counter only when the transcript reports it. A counter the transcript leaves out is null with the reason `unsupported_by_agent`, and only an explicit 0 in the transcript is 0. The readers share [[src/fork/usage/sources/token-counters.ts#tokenCounters]] for this. Lat never works out cost into `reported_cost_usd`. Any computed cost belongs to read time.

## Opt-in and the usage directory

Usage is opt-in per project. It is on when `.lat/usage/` exists as a real directory, not through a symlink, or when `LAT_USAGE=1` is set. The code is [[src/fork/usage/enabled.ts]].

Only two things create `.lat/usage/`: `lat usage enable`, and the logger of a project that is already on. Each one also writes `.lat/usage/.gitignore` holding `*`, so nothing in the directory can be committed. A process that writes into an existing `.lat/usage/` without that file adds it first. A `.gitignore` with any other content, such as an empty one a repository committed, is replaced the same way.

`lat usage enable` also makes sure `<project root>/.gitignore` ignores `.lat/usage/`, on the already-enabled path too. When no line there already ignores it (`.lat/usage`, `.lat/usage/` or `.lat/`, each with or without a leading slash), it appends the entry under a one-line comment that says why, and it creates the file when missing. A symlinked `.gitignore` is skipped with a one-line note, never written through. The code is [[src/fork/usage/tracked-usage.ts]].

Reading never opts a project in. The aggregator, the raw event index, graph snapshots, `lat usage`, `lat usage gaps`, the `lat_usage` MCP tool and the live endpoints never create the directory:

- When usage is off, they read no session store and no log, and run no bd. `lat usage` and `lat usage gaps` print that tracking is not enabled and exit 0. The dashboard shows its empty state. An aggregator or raw event index that is already running drops the events it holds when usage turns off, and reads them again when it turns back on.
- When only `LAT_USAGE=1` turns usage on and the directory does not exist, the aggregator keeps its state and graph snapshots in memory. It writes nothing to disk.
- A failed snapshot cache write never turns a built snapshot into a failure.

So `lat usage disable` stays effective: after it renames the directory, no read path brings it back.

A cloned repository can ship `.lat/usage/` with symlinks in it. Writers write only when `.lat`, `.lat/usage` and `graph-snapshots` are real directories, not symlinks. If one is a symlink, they write nothing. The events file is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and a line is written only when the opened file is a regular file, so a FIFO planted there never blocks a command. Temporary files are created exclusively after any stale one is unlinked, so a planted symlink is removed, not followed. The graph snapshot cache is not read through a symlinked `graph-snapshots`. `lat usage enable` and `lat usage disable` refuse with exit code 1 when `.lat`, `.lat/usage` or `.lat/usage.disabled` is a symlink.

Readers are guarded the same way. They read `state.json`, the events files and the snapshot cache only inside a real `.lat/usage`, and open each one with `O_NOFOLLOW` and `O_NONBLOCK`, then refuse anything that is not a regular file. A planted link to `/dev/zero` is never read.

A repository can still commit files under `.lat/usage/`, and a cloner then records into files git already tracks. The rule above stays, but when `git ls-files -- .lat/usage` lists any file, `lat usage` and the first start of the live state of a project root under `lat ui` print a warning on stderr, so `--json` on stdout stays clean. It says to run `git rm -r --cached .lat/usage` and names no file. Git runs without a shell, in the project root; when git is missing, fails, or the root is not in a repository, nothing is printed.

A `state.json` that exists but cannot be used, because it is unreadable, not valid JSON, or of the wrong version or shape, is reported once per process on stderr, and the aggregator starts from an empty state. The message quotes nothing from the file. A missing `state.json` is silent.

## Stored session events

The aggregator keeps session events in `.lat/usage/state.json`. A stored `tool_call` event has no shell command text. It keeps `shell.exit_code` only. To get the command, follow `source` (path and offset) back to the transcript line. The code is [[src/fork/usage/state.ts]].

So a restart needs no re-read. The stored state also holds the agent name beside each event, because a SessionEvent does not carry it.

## The bd database

Attribution to bd issues reads one bd database per project root, chosen by [[src/fork/usage/bd-client.ts#resolveBeadsDir]]. When `<project root>/.beads` is a directory, it is the database.

Then bd runs in the project root without `BEADS_DIR` in its environment, so a project database wins even when `BEADS_DIR` is exported for the whole machine. Otherwise `BEADS_DIR` is used when set, and bd runs as it did before. With neither, bd runs in the project root and finds its own database from there. With neither a project `.beads/` nor `BEADS_DIR`, or a store that cannot be fingerprinted, the fingerprint is empty. The live server then cannot see database changes, and every refresh reloads bd with two or three bd commands. A route request refreshes once. `/api/usage/raw`, and `/api/usage/findings` when its result is not cached, refresh twice. When bd is missing or finds no database, every event is unattributed.

While usage is off, no refresh runs bd and the live server does not fingerprint the database, so a repository that ships its own `.beads/` never has bd started in it.

## Savings

Net tokens saved is not a field of UsageEvent or SessionEvent. The aggregator computes it per row as `net_tokens_saved`. A savings contribution supplies it. When none does, or when it throws, the value is null and `net_tokens_saved_reason` says why.

The method lives in [[src/fork/usage/savings.ts]] and is `method_version` 1. Every result carries `method_version`, the label `correlation, not cause` (no holdout runs) and its inputs. Rows get only the point estimate. The range and the inputs are in `extensions.savings`.

A section read is a lat event with `section_id` set and a caller other than `hook-injected`. Its saved bytes are the bytes of the whole document that holds the section, taken from the graph snapshot at the event's `git_head`, minus its `bytes_out`. A negative saving stays negative. A hook event never saves anything. Its `injected_bytes` count as cost.

Bytes become tokens at read time, never when an event is written, at 3, 4 and 5 bytes per token. The low and high nets are the smallest and largest of the four pairings of the saved and injected ratios. The point uses 4 for both.

A read is unknown when `bytes_out` or `git_head` is null, when the head has no snapshot, or when the section is not in it. A hook event with a null `injected_bytes` is unknown too. Unknown inputs are counted with their reasons and never added as zero. When the reads of a row are all unknown, or its hook events are all unknown, `net_tokens_saved` is null and `net_tokens_saved_reason` says why.
