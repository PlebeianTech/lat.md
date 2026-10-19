---
lat:
  require-code-mention: true
---
# Knowledge Session Markers

Tests for the per-session marker store ([[src/knowledge/session.ts]]) that backs federation dedupe across separate hook processes in the same agent session, and the end-to-end federation flow that depends on it.

Tests in `tests/knowledge/session.test.ts`.

## Marker persistence

`loadSessionMarkers`/`saveSessionMarkers` persist a session's `seen` and `attemptedEmpty` sets to a per-session file on disk so separate `PostToolUse`/`UserPromptSubmit` hook processes in one session share dedupe state.

### Persists seen across load/save cycles

A document added to `seen`, saved, then reloaded for the same session id, is still present.

### Does not share seen markers across sessions

Two different session ids never see each other's `seen` markers.

### Retains a fresh attemptedEmpty entry on reload

An `attemptedEmpty` entry saved moments ago is still present on the next load — it isn't expired immediately.

### Expires attemptedEmpty entries older than the TTL

An `attemptedEmpty` entry backdated past `ATTEMPTED_EMPTY_TTL_MS` is dropped on load, so a document that later starts yielding results is reachable again.

### No session id means no persistence

`loadSessionMarkers(undefined)` returns a fresh, empty, in-memory-only result; `saveSessionMarkers` on it is a safe no-op that touches no shared file.

## Marker store hardening

The marker directory lives under a predictable, hash-derived path in the OS temp directory, so it has to withstand something already planted there.

### A symlinked marker directory disables persistence without throwing

If the per-session directory is itself a symlink to another location, loading and saving both silently no-op rather than following the symlink — the symlink itself is left untouched, and a later load still comes back empty.

### A symlinked marker file inside a legitimate directory is not followed

If `markers.json` inside an otherwise-legitimate marker directory is a symlink to attacker-controlled content, loading it does not surface that content — the load behaves as if the file were absent.

## Cross-process session federation

End-to-end tests running the built CLI's `UserPromptSubmit` hook as separate child processes, sharing session state only through the on-disk marker store.

### Federates once per session across two processes, and again in a different session

A document federates on the first `UserPromptSubmit` call, is skipped on a second call in the same session (same process boundary crossed via disk-backed markers), and federates again in a different session.

### Federates normally with no session id in the payload

A `UserPromptSubmit` payload carrying no `session_id` still federates — the absence of a session id degrades to no persistence rather than failing.
