---
lat:
  require-code-mention: true
---

# Usage Missed Knowledge

Tests in `tests/usage-missed-knowledge.test.ts` for `src/fork/usage/missed-knowledge.ts`.

They write a graph snapshot into the cache of a temporary git repository, so no test reads the real project graph. Sessions come from a fake reader and lat commands from the event log. A source file counts as covered by a section when a code-ref edge or a symbol-ref edge of the snapshot links them.

The result lands in `extensions.missed_knowledge`. The reasons are inferred from what the agent did, not from what it intended, and reach on a feature or task measures changes to existing, documented code.

## A section read before the first edit is reached

A section that a lat section command, a lat expand result or an MCP call named before the first edit of a file it covers has the outcome reached.

## A section read after the first edit is read-late

A section read only after the first edit of a file it covers has the outcome read-late.

## Read-late uses the earliest edit of any covered file

When a section covers two edited files, the earliest edit of either decides. A read between the two edits is read-late.

## A raw read of the lat.md file is bypassed

A native read or search under lat.md, or a bypass read event, of the document that holds the section gives the outcome bypassed. A native Grep is never a search.

## A section found but not opened is found-not-opened

A section that appeared in the results of a search, including a hook-injected one, but that no lat read named, has the outcome found-not-opened.

## A search that never returned the section is searched-not-found

A session that searched, with an agent or a hook as caller, but never saw the section in any result has the outcome searched-not-found. The record lists the normalized queries the session ran before its first edit.

## A section nothing touched is never-consulted

Every other expected section is never-consulted. A session that only ran `lat check` gets this outcome for each expected section.

## The outcomes are checked in order

When two outcomes could apply, the first in this order wins: reached, read-late, bypassed, found-not-opened, searched-not-found, never-consulted.

## A hook injected body counts as a read

A hook event that has a section id injected the full body, so it counts as a read of that section at its time.

## A lat section in a shell call is a fallback read

A shell call that ran `lat section` with an exact section id counts as a read when no event shows it. The command text is read through the source pointer and is never stored.

## Files without a section are no-coverage

An edited file that no section covers is no-coverage and is no miss. A file absent from the tree at the head is new-file. A file present there is undocumented. A tree that cannot be listed makes the file unclassified.

An edit to a file under `lat.md/` is a knowledge edit and is not counted at all.

## The tree listing is relative to a subdirectory root

When the project root is a subdirectory of the repository, the files are matched and listed relative to that root, and files outside it are ignored.

## A symbol-ref edge covers a file

A section that cites a file as file#symbol covers that file, also when the snapshot has no code-ref edges. Such a file is not undocumented.

## A recovered snapshot is seen after the snapshot cache is forgotten

A head whose snapshot failed is not captured.

When the snapshot becomes available and `forgetSnapshots()` clears the graph snapshot cache, as the live server does when the git head moves, the next summary measures the session. Missed knowledge keeps no snapshot of its own across summaries.

## A snapshot without edges is not captured

A session whose snapshot has no code-ref edges and no symbol-ref edges has no expected sections, counts as not_captured and has no miss.

## Lat commands join sessions by id or by time window

An event with a session id belongs to that session. Without one it belongs to the single session of the same agent and worktree whose window holds its time. Zero or several matches leave it out and count it as unjoinable.

## The snapshot follows the earliest head of the session

The snapshot is the one at the earliest git head of the lat commands of the session, the tree before the session's own commits. A session without lat commands uses the latest head of the range.

A section or file the session created and committed is therefore not expected of it, and the file counts as new-file.

## Reach is reached over expected

Reach is the reached sections over the expected sections. With no expected sections it is null with a reason, never 0.

## Reach is split by issue type

Each issue of a session counts under its own bd type, never an ancestor's. A session shared by issues of two types counts once under each. Sessions with no issue count as unknown.

## Reach is split by agent and by session

Rows by agent and by session carry the same figures.

## Every expected section has one record

There is one record per session and expected section with its session id, section id, outcome, session start and git head. A session has had_a_miss when any outcome is not reached.

## The result carries series and lists for consumers

The result has the reach per UTC day of the session start, the reach of the previous range, the undocumented files with their sessions and edit counts, and the unjoinable events.

## The result names its method

The result has a method_version, a note that the reasons are inferred and a note that it measures existing documented code.

## A transcript line is read only from a regular file

A transcript path comes from a session index that a repository can plant. A symlink or a FIFO named `*.jsonl` gives no line, at once, and a regular file gives the line at the offset.

## Prepare and compute run once per context

A second prepare on the same context makes no snapshot call, and a second compute returns the first result object, so one summary measures once.
