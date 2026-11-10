---
lat:
  require-code-mention: true
---

# Usage Live

Tests in `tests/usage-live.test.ts` for `src/fork/usage/live.ts` and its one dispatch line in `src/view/server.ts`.

They start a real `lat ui` server on a temporary project root with a fixture `usage.html` in a temporary client directory, fake session sources and a stubbed bd watcher. None reads a real agent store or the live bd database, and none asserts on elapsed time, except the burst test, which waits a fixed interval to see that no second push comes. Each triggers a change, then awaits the push.

## Routes register through registerUsageRoute

A handler registered with `registerUsageRoute` is served under its path as JSON, and receives the request's parsed filters, the project root and the aggregator.

`/api/usage` is registered the same way, so a later issue adds a route with one line.

## Filters come from the query string

`from`, `to`, `agent`, `session` and `issue` narrow the aggregate as they do for `lat usage`; a date-only `to` includes its whole day. An invalid date answers 400 with the reason.

## The session rows have their own route

`GET /api/usage` leaves out the session rows, the bulk of the summary; `GET /api/usage/sessions` serves them as `sessions`, narrowed by the same filters.

## A new event is pushed once and then read

After an event is appended to the log, the event stream sends exactly one `usage-change`, and the next `GET /api/usage` includes the event.

The stream opens with a `ready` event that carries a server-lifetime id, and sends heartbeat comments.

## A burst of changes is one refresh

Several events appended within the debounce interval make one check, one `usage-change` push and one refresh, not one per file event.

## Source discovery is reused between checks

A check caused by a file event reuses the session files found earlier, and so does the refresh after it: a change that adds no file calls `discover` on no source. A new file in a watched store directory is found at once, and a poll looks again.

## Requests after a change share one discovery

The aggregator finds its session files through the same discovery as the change check. After one change, ten requests to `/api/usage` sent together call `discover` once on each source, not once per request.

## A walk in flight is shared and an invalidation is kept

A caller that asks while a source is being discovered gets that discovery. When the discovery is invalidated while it runs, the next caller starts a new one, so a file that appeared during the walk is not lost.

## A poll finds a file in a store nobody watches

A session file in a directory that no watcher covers is found by the next poll, which pushes `usage-change`.

## Usage off reads no session store

On a project where usage is not enabled, the live server calls `discover` on no session source and watches no transcript directory, as [[usage-analytics#Usage Analytics#Opt-in and the usage directory]] requires.

## Usage on again discovers afresh

When a check finds usage off, the live server forgets the session files it found. After usage is turned on again, the next request calls `discover` once, and the requests after it reuse that result.

## A failing refresh is pushed once

When a refresh throws, such as when bd fails while usage is on, the stream sends one `usage-error` event with `{ instanceId, message }`, so a client can show stale data.

The signature and git head still advance: later polls neither retry the failure nor forget graph snapshots again. A head change forgets snapshots exactly once. The next successful change sends `usage-change`, which clears the error.

## A project below the repository root sees head moves

When the project root is a subdirectory of the git repository, the head is read from the nearest `.git` above it. A change to that repository's `logs/HEAD` makes the next check run `forgetSnapshots()` once.

## The dashboard page is served at any depth

`/_usage` and `/_usage/sessions/x` answer with `usage.html` from the client directory, its asset URLs rewritten to the root, so the page loads from any depth. A missing page answers 404.

## A static export leaves the dashboard page out

`removeUsageDashboard` deletes `usage.html` from a static payload and keeps every other file. It does nothing when the page is not there.

## Documents named usage stay reachable

The dashboard lives under `/_usage`, so `/usage` and `/usage/guide` reach the document routes of `lat.md/usage.md` and `lat.md/usage/guide.md` and get the app shell, not the dashboard page.

## A restart resumes from state.json

After the last stream client leaves and the watchers stop, a new request catches up from `state.json` and shows every earlier event plus those appended in between.

## Watchers follow the stream clients

Watchers start on the first `/api/usage` request and stop when the last event-stream client disconnects, not before.

## A disconnect releases its stream

A client that disconnects is dropped from the stream set and receives no further writes.

## The change signature follows the resolved bd database

While usage is on, a change to the bd database that `resolveBeadsDir` picks for the project root pushes `usage-change`. A project's own `.beads/` is watched even when `BEADS_DIR` names another store; without one, `BEADS_DIR` is watched.

## Usage off watches no bd database

On a project where usage is not enabled, a change to the project's own `.beads/` database pushes no `usage-change`, because the live server does not read that database, as [[usage-analytics#Usage Analytics#Opt-in and the usage directory]] requires.

## The shared bd watcher is made for the project root

A live server given no bd watcher makes one for its project root, so the watcher finds the database of that root and not of the process.
