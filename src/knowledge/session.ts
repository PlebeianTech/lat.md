// Session-scoped persistence for federation dedupe markers.
//
// `lat hook` runs as a fresh process per prompt, so the in-process `seen` and
// `attemptedEmpty` Sets that `federateTags` accepts start empty every time
// unless something persists them across invocations. This module is that
// something: a small on-disk marker store keyed on the hook payload's
// session id.
//
// The marker path is predictable from the session id (a hash of it), so
// another local user who can predict or observe the session id could plant a
// symlink there ahead of us. The checks below port the `private_dir` pattern
// from the shell hooks this ports from: verify no symlink, create with mode
// 0700, then re-verify ownership and mode AFTER creation (mkdir -p succeeds
// silently on a path that's already a symlink to a directory). Every open
// additionally passes O_NOFOLLOW so a link planted in the gap between our
// checks and the actual read/write still can't be followed.
//
// Failing any of this must never fail the prompt and must never suppress a
// lookup: on any doubt about the marker path's safety, we drop back to fresh,
// empty Sets. Federation still runs (with no cross-prompt memory for this
// call) rather than either crashing or letting a hostile file decide whether
// federation fires.

import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How long a document stays in `attemptedEmpty` across prompts. Short and
 * deliberately so: this set means "found nothing last time, worth another
 * look once a store has something to say", not "never look again". A long
 * or missing expiry would let a document that happened to catch the stores
 * cold on prompt one stay unreachable for the rest of the session — the
 * exact starvation bug the attempt-budget rotation exists to prevent.
 */
export const ATTEMPTED_EMPTY_TTL_MS = 5 * 60 * 1000;

export type SessionMarkers = {
  seen: Set<string>;
  attemptedEmpty: Set<string>;
};

/**
 * A loaded session's markers plus enough state to save them back correctly.
 * `federateTags` mutates `markers.seen` / `markers.attemptedEmpty` in place;
 * pass the same handle to `saveSessionMarkers` afterward so an id that was
 * already in `attemptedEmpty` before this call keeps its original recorded
 * time instead of having its TTL silently refreshed on every prompt.
 */
export type SessionHandle = {
  sessionId: string | undefined;
  markers: SessionMarkers;
  /** doc id -> original timestamp, for entries loaded from disk. */
  attemptedEmptySince: Map<string, number>;
};

type StoredMarkers = {
  seen: string[];
  /** doc id -> timestamp (ms since epoch) the empty attempt was recorded. */
  attemptedEmpty: Record<string, number>;
};

function markerDir(sessionId: string): string {
  const hash = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(tmpdir(), `lat-session-${hash}`);
}

function markerFile(sessionId: string): string {
  return join(markerDir(sessionId), 'markers.json');
}

/**
 * Verify (and if needed, tighten) that `dir` is a private directory we own,
 * creating it if absent. Returns false on anything that looks even slightly
 * off — a symlink, a directory owned by someone else, permissions we can't
 * correct — rather than trying to be clever about partial trust.
 */
function ensurePrivateDir(dir: string): boolean {
  try {
    // Refuse a pre-existing symlink outright, before mkdir touches it.
    try {
      const preStat = lstatSync(dir);
      if (preStat.isSymbolicLink()) return false;
    } catch {
      // Doesn't exist yet — fine, mkdir below creates it.
    }

    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Re-check AFTER mkdir: `mkdir` with `recursive: true` succeeds silently
    // on a path that is already a symlink to a directory, so the check above
    // alone isn't enough — an attacker could win the race between it and the
    // mkdir call.
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) return false;

    if (typeof st.uid === 'number' && typeof process.getuid === 'function') {
      if (st.uid !== process.getuid()) return false;
    }

    // Mode must be exactly 0700: group/world access on a directory holding
    // doc summaries and store hits is a leak, not just a corruption risk.
    if ((st.mode & 0o777) !== 0o700) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Open with O_NOFOLLOW so a symlink planted after ensurePrivateDir's checks
 * still can't be followed for the actual read/write.
 */
function openNoFollow(
  path: string,
  flags: number,
  mode?: number,
): number | null {
  try {
    return openSync(path, flags, mode);
  } catch {
    return null;
  }
}

function emptyHandle(sessionId: string | undefined): SessionHandle {
  return {
    sessionId,
    markers: { seen: new Set(), attemptedEmpty: new Set() },
    attemptedEmptySince: new Map(),
  };
}

/**
 * Load persisted markers for a session. Returns a handle with fresh, empty
 * Sets — never throws, never blocks the caller — whenever the marker path is
 * missing, unreadable, unsafe, or corrupt. An empty result just means
 * federation runs as if this were the first prompt of the session: dedupe is
 * lost for this call, but the lookup itself still happens.
 *
 * No session id means no persistence: the caller gets fresh Sets and
 * `saveSessionMarkers` becomes a no-op, never falling back to any shared or
 * global file.
 */
export function loadSessionMarkers(
  sessionId: string | undefined,
): SessionHandle {
  // `sessionId` typically arrives via `JSON.parse` on untyped hook input, so
  // a malformed or differently-shaped payload can hand this a non-string.
  // Treat that exactly like "no session id" rather than letting it reach
  // createHash() and throw past this function's callers.
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return emptyHandle(undefined);
  }

  const dir = markerDir(sessionId);
  if (!ensurePrivateDir(dir)) return emptyHandle(sessionId);

  const file = markerFile(sessionId);
  const fd = openNoFollow(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  if (fd === null) return emptyHandle(sessionId);

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return emptyHandle(sessionId);
    const raw = readFileSync(fd, 'utf8');
    const parsed = JSON.parse(raw) as StoredMarkers;
    const seen = new Set<string>(Array.isArray(parsed.seen) ? parsed.seen : []);

    const now = Date.now();
    const attemptedEmpty = new Set<string>();
    const attemptedEmptySince = new Map<string, number>();
    if (parsed.attemptedEmpty && typeof parsed.attemptedEmpty === 'object') {
      for (const [id, ts] of Object.entries(parsed.attemptedEmpty)) {
        if (typeof ts === 'number' && now - ts < ATTEMPTED_EMPTY_TTL_MS) {
          attemptedEmpty.add(id);
          attemptedEmptySince.set(id, ts);
        }
      }
    }

    return {
      sessionId,
      markers: { seen, attemptedEmpty },
      attemptedEmptySince,
    };
  } catch {
    return emptyHandle(sessionId);
  } finally {
    closeSync(fd);
  }
}

/**
 * Persist a handle's markers after a `federateTags` call has mutated them.
 * An id already present at load time keeps the timestamp it was loaded
 * with, so its TTL counts from when it first came back empty, not from
 * every subsequent prompt that re-skips it for free. An id that is new this
 * call is stamped with the current time.
 */
export function saveSessionMarkers(handle: SessionHandle): void {
  const { sessionId, markers, attemptedEmptySince } = handle;
  if (!sessionId) return;

  const dir = markerDir(sessionId);
  if (!ensurePrivateDir(dir)) return;

  const now = Date.now();
  const attemptedEmpty: Record<string, number> = {};
  for (const id of markers.attemptedEmpty) {
    attemptedEmpty[id] = attemptedEmptySince.get(id) ?? now;
  }

  const payload: StoredMarkers = {
    seen: [...markers.seen],
    attemptedEmpty,
  };

  const file = markerFile(sessionId);
  const fd = openNoFollow(
    file,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  if (fd === null) return;
  try {
    writeFileSync(fd, JSON.stringify(payload));
  } catch {
    // Best-effort; a failed write just means this call's markers aren't
    // persisted, same as if the session had no marker store at all.
  } finally {
    closeSync(fd);
  }
}
