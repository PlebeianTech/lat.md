---
lat:
  require-code-mention: true
---

# Usage Live

Tests in `tests/usage-live.test.ts` for `src/fork/usage/live.ts` and its one dispatch line in `src/view/server.ts`.

They start a real `lat ui` server on a temporary project root with a fixture `usage.html` in a temporary client directory, fake session sources and a stubbed bd watcher. None reads a real agent store or the live bd database, and none asserts on elapsed time, except the burst test, which waits a fixed interval to see that no second push comes, and the WAL database test, which waits for an interval with no `discover` call. Each triggers a change, then awaits the push.

## Routes register through registerUsageRoute

A handler registered with `registerUsageRoute` is served under its path as JSON. It receives `{ root, url, filters, aggregator, bd, sources }` and returns a value that JSON can serialize.

The filters are parsed from the query string by `parseUsageFilters`. The aggregator is refreshed before every handler call.

`bd` is the one bd watcher of the root and `sources` are the sources that share one discovery. Both are unset for MCP. A handler that reads the raw event index passes it `bd` and `sources`.

`/api/usage` is registered the same way, so a later issue adds a route with one line.

## Filters come from the query string

`from`, `to`, `agent`, `session` and `issue` narrow the aggregate as they do for `lat usage`; a date-only `to` includes its whole day. An invalid date answers 400 with the reason.

## The session rows have their own route

`GET /api/usage` leaves out the session rows, the bulk of the summary; `GET /api/usage/sessions` serves them as `sessions`, narrowed by the same filters.

## A new event is pushed once and then read

After an event is appended to the log, the event stream sends exactly one `usage-change`, and the next `GET /api/usage` includes the event.

The stream opens with a `ready` event that carries a server-lifetime id, and sends heartbeat comments.

## A session path with no file follows its change files

The optional `changeFiles` member of a session source returns the real files whose changes mean a session changed. It must not throw. Without it, the session path itself is that file.

A change to such a file, in a directory only that file brings into the watch, pushes `usage-change` and runs discovery again, because a database write can be a new session.

## Reading a WAL database starts no new discovery

When no other connection is open, each read-only open of a SQLite database in WAL mode creates its `-shm` file again. The watcher ignores a file name that ends in `-shm`, so one discovery does not start the next.

OpenCode's `discover` opens its database this way. A real write reaches the database or its `-wal` file, so those files still start a new discovery.

The test uses a real WAL database with no other connection. It runs one check after the watcher starts, so that a read-only open happens while the watcher listens. The count of `discover` calls must then stop growing. A write from a second connection must then start a new discovery after that connection closes. On macOS the watcher reports no event while a connection holds the file open, so a write from a connection that stays open is found by the next poll.

## A burst of changes is one refresh

Several events appended within the debounce interval make one check, one `usage-change` push and one refresh, not one per file event.

## Source discovery is reused between checks

A check caused by a file event reuses the session files found earlier, and so does the refresh after it: a change that adds no file calls `discover` on no source. A new file in a watched store directory is found at once, and a poll looks again.

A store directory can be shared. Codex keeps the rollouts of all projects in the same dated directories, so another project's active session can write there many times. What a watcher event in a store directory does depends on the file it names:

- A file that discovery listed starts no new discovery.
- A change file that discovery did not list, such as OpenCode's database or its `-wal` file, starts a new discovery on every event, because a database write can be a new session.
- Any other file starts a new discovery the first time it is seen after a poll, because it may be a new transcript. More events for that file start none until the next poll. A file that becomes a transcript only after its first write is found by the next poll.
- An event with no file name starts a new discovery.

The test writes to an unlisted file and then to a listed transcript, and waits for the push. Watcher events arrive in order, so the event for the unlisted file has been handled by then. Repeated writes to one unlisted file must cost one `discover` call in total, and a second unlisted file one more. The test then runs the poll callback by hand. The poll discovers once, and the next write to the first file discovers once again.

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
