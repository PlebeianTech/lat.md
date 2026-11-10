---
lat:
  require-code-mention: true
---

# Usage Dashboard Sessions

Tests in `tests/usage-dashboard-sessions.test.tsx` for the Sessions page of the usage dashboard: a sortable table of sessions with subagents nested under their parent, and a session detail view with a timeline of its events.

They render the page in jsdom with a fake `fetch` serving fixtures typed from `src/fork/usage/aggregate-types.ts` and `src/fork/usage/event-index.ts`, and a fake `EventSource`. None asserts on elapsed time.

## The table lists sessions with all columns and nests subagents

Each session is one row with name (the id when unnamed), agent, start, duration, lat commands, search hit rate, bypass reads, tokens used and the bd issues worked.

A subagent session sits under its parent and shows once the parent is expanded. A value the data layer could not supply reads "unknown", never 0.

## A session with more than 200 events loads every event

The detail view asks the raw events endpoint for the session and follows the cursor until the last page, so a session of 250 events shows all 250 even though a page holds at most 200.

## The detail timeline places each event in the right lane at the right time

Lat commands, bypass reads, bd claims and closes, and injected hook context each go in their own lane, at the time of the event. Events of other kinds are not drawn.

A lat command is labelled `lat <command>`; a hook run is labelled with its command as recorded, such as `hook Stop`.

## Selecting an event shows its fields

Choosing an event in the list under the timeline shows the stored fields of that event: its id, type, time and the fields of its kind. It never shows a command line or any transcript text.

A null usage field, such as section or injected bytes, reads "unknown" only when the event records a reason for it in `unknown_reasons`; otherwise it reads "—", as for the error class of a successful command.

## Another session never shows the previous session's events

Moving from one session's detail page to another clears the timeline and the selected event, and shows "Loading events…" until the new session's events arrive.

## Links keep the filter query string

Every link to another page or detail view carries the current filters as a query string: the session rows, the parent and subagent links, the issue links and the way back to the list.

## Unknown token counts are shown

The Tokens column holds the known total. The next column, "Unknown counts", holds the number of unknown input counts plus unknown output counts, as "+k unknown".

A session with nothing known reads "unknown", never 0. The detail header reads "total (+k unknown counts)". A message with both counts unknown adds 2, so the column is not a message count. The summary has no per-message figure.

## Loading and error states

While nothing is loaded the page says so, and a session detail page does not claim the session is missing from the summary. An error shows its message and keeps the last data visible. With no sessions under the filters the page says there are none.

## A session with no token usage message shows unknown tokens

A session with no token usage message at all has token sums of 0 with nothing known, for example when its transcript expired. The Tokens and Unknown counts columns and the detail panel show unknown for it, never 0 or none.
