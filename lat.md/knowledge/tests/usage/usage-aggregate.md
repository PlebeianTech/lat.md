---
lat:
  require-code-mention: true
---

# Usage Aggregate

Tests in `tests/usage-aggregate.test.ts` for `src/fork/usage/aggregate.ts`, `state.ts` and `filters.ts` in the same folder.

They use synthetic usage events, synthetic session events, fake session sources and a stubbed bd snapshot, in a temporary project root. None reads a real agent store or the live bd database.

## Feeding the same events twice changes nothing

Ingesting a batch of usage events and session events a second time, by log re-read or by a reader that re-emits, produces a summary equal to the first.

## Summaries are memoized per data version

Two concurrent identical summaries share one computation, and a repeat after a refresh that read nothing new is served from the cache.

Different filters compute again. New data, or `invalidate()`, starts a new data version, so the next summary is computed afresh. The cache key also holds the UTC day, so relative ranges move on at midnight.

## A memo computed across a reset is not cached

A memoized computation still running when the data version changes answers its own caller once and is not run again.

Its result is not stored, so a later caller for the same key computes afresh.

## A summary ignores a refresh in progress

While a refresh has read a new agent reason but is still waiting for bd, a summary reports the reasons of the data version it was built from.

The next summary, after the refresh ended, reports the new reason.

## A restart resumes from state.json

An aggregator stopped after its first refresh and rebuilt from `state.json` reads only the new log lines and new session events.

Its summary equals that of one aggregator that ran uninterrupted. A log that shrank is read again from its start without double counting.

## A session event with an unreadable time is dropped

A session event whose `ts` does not parse never enters the state. The aggregation succeeds, `state.json` does not hold the event, and an aggregator restarted from that state succeeds with the same totals.

## An event dated out of range is dropped

A usage line or session event whose `ts` is before 2000-01-01 or more than one day after now never enters the state.

One event in year 3000 would otherwise make the daily series span hundreds of thousands of days and run the process out of memory. The summary builds normally and its day list stays short.

## A usage line of the wrong shape is dropped

A usage log line with the wrong `schema_version`, a missing field, or a field of the wrong type is dropped, and the aggregation succeeds.

The variants are a number `query` or `section_id`, a `result_ids` entry that is not a string, a missing `section_id`, and similar. The valid line written beside them is counted, and `state.json` holds none of the dropped events.

## Turning usage off empties the summary

When `.lat/usage/` is renamed away while an aggregator runs, its next refresh drops the events it holds, and the summary is empty. When the directory comes back, the summary equals the one before.

## Latest wins for repeated session events

Readers re-emit `session_end`, `model` and `session_name` on every resumed read with new event ids. Each session keeps only the latest of each kind, so its end time, model and name are not added up.

A `token_usage` event re-emitted with the same event id and a later ts replaces the stored one, so a message's final token count replaces a partial count from an earlier read.

## All five agents are listed

The agent breakdown has one row for each of claude, codex, pi, opencode and antigravity, with zero counts when an agent has no sessions.

An agent that has events but no session reader is listed too. A reader that reports a reason for missing data carries the reason on its agent row.

## Sessions keep children separate

A subagent session is its own row with its `parent_session_id`.

The parent row carries its own totals and rolled-up totals that include its children, through any depth. A row shows its start, end, duration, agent, name, model, tokens, lat commands, bypass reads and the bd issues it worked on.

## Issues carry own and rolled-up totals

An issue row carries the totals of events attributed to it and, separately, the totals including its descendants. It also names its bd parent, which need not share a dotted id with it, or null for a top-level issue.

An event credited to a parent and a child counts once in the parent's rolled-up totals. Events attributed to no issue go to an unattributed row.

A shared event counts in full in each issue's own totals. The grand total counts it once, because it comes from the events and not from the issue rows.

## Commands and days

The command breakdown counts non-hook events by command name. The day breakdown has one row per UTC day.

## Queries are normalized

Queries that differ in case or spacing are one row.

A query row has its count, its sessions, its median result count, its empty-result share, its follow-through share, its median opened rank, the sections it returned with how often each was opened, and its reformulations.

## A query row carries its opened ranks and reformulation targets

Each query row has the ranks at which its searches' results were opened, per section, and the queries that followed it within 60 seconds, with counts.

Both come from the same event-order pass as the row's counts, so they cannot drift from them. A follow-up search without a query counts under a null query.

## A section id never collides with an object property

A section id such as `__proto__`, `constructor` or `toString` is a key like any other. The summary does not throw, and the opened ranks of that section reach the row as an own key.

The ranks are collected in a Map and emitted with `Object.fromEntries`, so an id taken from an event cannot reach `Object.prototype`.

## An agent name never collides with an object property

An agent named `constructor`, `toString` or `__proto__` gets its own row. The summary does not throw, the row counts the commands of that agent, and its reason is null.

The reason of a row is looked up with `Object.hasOwn`, so an agent name taken from an event cannot reach `Object.prototype`.

## An event id never collides with an object property

A usage event or a session event whose id is `__proto__` or `constructor` is stored like any other. Adding it a second time changes nothing and does not throw.

The usage and session maps of the state have no prototype, so an id taken from an event cannot reach `Object.prototype`.

## Query facts pair reads over the whole log

Under an agent, session or date filter, a read is paired with the latest earlier search of its session in the unfiltered log, not with a search that survived the filter.

A search by another agent between a search and its read therefore stops the read from following the first search, and the facts say so.

## Another search within 60 seconds is a reformulation

A search followed by another search in the same session within 60 seconds is reformulated. One at 61 seconds is not, and a search in another session is not.

## A read follows only the latest earlier search

A section read follows a search when the same session's most recent earlier search has that section in its result ids.

The rank opened is its 1-based position there. A section in an older search only, or in a search of another session, is not followed and has no rank.

## Hook injections are not reads

A hook-injected event with a section id is not a section read and not a command. Its injected bytes are totalled apart.

## Sections and documents count reads

A section row has its reads, its reads for each day, the queries whose search led to the read and the bd issues, with ancestors, whose sessions read it. A document row sums the reads of its sections.

## Unknown is not zero

A null token counter, result count or output size is counted as unknown and never added as zero. A total whose every value is unknown is null.

## Daily series and the previous range

Every row carries one point for each UTC day of the range and the totals of the previous range of equal length. Without a start date there is no previous range, and the field is null.

## Totals carry commands per session, search hit rate and follow-through

Every Totals, so the previous range and each daily point too, holds commands per session, search hit rate and follow-through.

The Overview shows commands per session and follow-through, and holds no formula of its own. Search hit rate has no Overview tile.

Search hit rate is the searches with a result over the searches with a known result count. Follow-through is the followed searches over all searches.

## Each row carries five health signals

Agent, session and issue rows carry lat commands per session, search hit rate, follow-through, bypass rate, and net tokens saved with the injected bytes beside it. Net tokens saved is null until a contribution supplies it.

## Filters narrow the summary

`parseUsageFilters` reads `from`, `to`, `agent`, `session` and `issue` from a query string or a plain object.

A date-only `to` includes that day. An invalid date throws. The session filter matches an id or a name. The issue filter includes descendants. Filtering does not change how events are attributed.

## Contributions register one line each

A contribution listed in the registration array adds its result under `extensions` in the summary, and may supply net tokens saved.

## A throwing contribution is isolated

A contribution whose `compute` throws is reported as an error object under its key in `extensions`. The other contributions and the rest of the summary are unaffected.

A throwing `netTokensSaved` leaves the signal null and names the reason beside it.

## state.json keeps no shell command text

Session events are stored in `state.json` as pointers, not copies of transcript text. A tool call keeps its name, action, path, bytes, shell exit code and `source` pointer, and drops the shell command string.

A consumer that needs the command re-reads the source line through the pointer.

## A parent link on any event attributes a subagent

A subagent session whose parent link appears only on a `session_start` or a `tool_call` still gets its lat commands attributed through the parent's claim.

The Sessions table shows the same parent.

## Prepare runs before rows are built

A contribution's optional `prepare` is awaited before any row is built. Its synchronous `netTokensSaved` sees the prepared state on the first summary.

## A throwing prepare is isolated

A throwing `prepare` is recorded under the contribution's key like a throwing `compute`, and `compute` is skipped. Its `netTokensSaved` yields null with the error as reason. Other contributions and the summary are unaffected.
