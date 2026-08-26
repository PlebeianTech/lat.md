import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  symlinkSync,
  rmSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { rmDirBestEffort } from '../util.js';
import {
  loadSessionMarkers,
  saveSessionMarkers,
  ATTEMPTED_EMPTY_TTL_MS,
} from '../../src/knowledge/session.js';

const cliPath = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

function markerDirFor(sessionId: string): string {
  const hash = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(tmpdir(), `lat-session-${hash}`);
}

describe('session markers', () => {
  const madeDirs: string[] = [];

  afterEach(() => {
    for (const d of madeDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function freshSessionId(label: string): string {
    const id = `session-${label}-${Date.now()}-${Math.random()}`;
    madeDirs.push(markerDirFor(id));
    return id;
  }

  // @lat: [[knowledge-session#Marker persistence#Persists seen across load/save cycles]]
  it('persists seen across separate load/save cycles for the same session', () => {
    const sessionId = freshSessionId('seen');

    const first = loadSessionMarkers(sessionId);
    expect(first.markers.seen.size).toBe(0);
    first.markers.seen.add('doc-a');
    saveSessionMarkers(first);

    const second = loadSessionMarkers(sessionId);
    expect(second.markers.seen.has('doc-a')).toBe(true);
  });

  // @lat: [[knowledge-session#Marker persistence#Does not share seen markers across sessions]]
  it('does not share seen markers across different sessions', () => {
    const sessionA = freshSessionId('a');
    const sessionB = freshSessionId('b');

    const a = loadSessionMarkers(sessionA);
    a.markers.seen.add('doc-a');
    saveSessionMarkers(a);

    const b = loadSessionMarkers(sessionB);
    expect(b.markers.seen.has('doc-a')).toBe(false);
  });

  // @lat: [[knowledge-session#Marker persistence#Retains a fresh attemptedEmpty entry on reload]]
  it('retains a fresh attemptedEmpty entry on reload (not expired immediately)', () => {
    const sessionId = freshSessionId('empty');

    const first = loadSessionMarkers(sessionId);
    first.markers.attemptedEmpty.add('doc-x');
    saveSessionMarkers(first);

    const second = loadSessionMarkers(sessionId);
    expect(second.markers.attemptedEmpty.has('doc-x')).toBe(true);
  });

  // @lat: [[knowledge-session#Marker persistence#Expires attemptedEmpty entries older than the TTL]]
  it('expires attemptedEmpty entries older than the TTL', () => {
    const sessionId = freshSessionId('expired');
    const dir = markerDirFor(sessionId);
    const file = join(dir, 'markers.json');

    // Prime the directory the same way loadSessionMarkers would, then
    // backdate the timestamp past the TTL directly on disk.
    const first = loadSessionMarkers(sessionId);
    first.markers.attemptedEmpty.add('doc-old');
    saveSessionMarkers(first);

    const stale = {
      seen: [],
      attemptedEmpty: { 'doc-old': Date.now() - ATTEMPTED_EMPTY_TTL_MS - 1 },
    };
    require('node:fs').writeFileSync(file, JSON.stringify(stale));

    const reloaded = loadSessionMarkers(sessionId);
    expect(reloaded.markers.attemptedEmpty.has('doc-old')).toBe(false);
  });

  // @lat: [[knowledge-session#Marker persistence#No session id means no persistence]]
  it('no session id means no persistence and a fresh empty result', () => {
    const handle = loadSessionMarkers(undefined);
    expect(handle.markers.seen.size).toBe(0);
    expect(handle.markers.attemptedEmpty.size).toBe(0);
    handle.markers.seen.add('doc-a');
    // Must be a no-op; nothing to assert on disk since there's no path, but
    // it must not throw and must not touch any shared/global file.
    expect(() => saveSessionMarkers(handle)).not.toThrow();
  });

  // @lat: [[knowledge-session#Marker store hardening#A symlinked marker directory disables persistence without throwing]]
  it('a symlink planted at the marker directory disables persistence but still loads empty markers without throwing', () => {
    const sessionId = freshSessionId('symlink-dir');
    const dir = markerDirFor(sessionId);
    const evilTarget = join(tmpdir(), `lat-session-evil-target-${Date.now()}`);
    require('node:fs').mkdirSync(evilTarget, { recursive: true });
    madeDirs.push(evilTarget);
    symlinkSync(evilTarget, dir);

    const handle = loadSessionMarkers(sessionId);
    // Dedupe disabled: fresh, empty sets rather than following the symlink.
    expect(handle.markers.seen.size).toBe(0);
    expect(handle.markers.attemptedEmpty.size).toBe(0);

    // The symlink itself must be left alone, not replaced or followed.
    expect(existsSync(dir)).toBe(true);

    handle.markers.seen.add('doc-a');
    expect(() => saveSessionMarkers(handle)).not.toThrow();

    // A later load must still come back empty — the planted symlink must
    // never start "working" once a save is attempted against it.
    const reloaded = loadSessionMarkers(sessionId);
    expect(reloaded.markers.seen.size).toBe(0);
  });

  // @lat: [[knowledge-session#Marker store hardening#A symlinked marker file inside a legitimate directory is not followed]]
  it('a symlinked marker file inside a legitimate directory is not followed', () => {
    const sessionId = freshSessionId('symlink-file');
    const dir = markerDirFor(sessionId);

    // Let the store create its own private directory first.
    const priming = loadSessionMarkers(sessionId);
    saveSessionMarkers(priming);

    const file = join(dir, 'markers.json');
    rmSync(file, { force: true });
    const evilFile = join(tmpdir(), `lat-session-evil-file-${Date.now()}`);
    require('node:fs').writeFileSync(
      evilFile,
      JSON.stringify({ seen: ['leaked'], attemptedEmpty: {} }),
    );
    madeDirs.push(evilFile);
    symlinkSync(evilFile, file);

    const handle = loadSessionMarkers(sessionId);
    expect(handle.markers.seen.has('leaked')).toBe(false);
  });
});

describe('lat hook UserPromptSubmit federation: cross-process session persistence', () => {
  let tmp: string;
  let dbPath: string;
  let caseDir: string;
  let emptyHome: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lat-session-e2e-'));

    caseDir = join(tmp, 'project');
    cpSync(join(import.meta.dirname, '..', 'cases', 'tags-basic'), caseDir, {
      recursive: true,
    });

    emptyHome = join(tmp, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });

    dbPath = join(tmp, 'cq.db');
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute(
      'CREATE VIRTUAL TABLE knowledge_units_fts USING fts5(summary, action)',
    );
    await client.execute({
      sql: 'INSERT INTO knowledge_units_fts (summary, action) VALUES (?, ?)',
      args: ['A run-pin lesson', 'Pin the run before carrying it'],
    });
    client.close();
  });

  const sessionDirs: string[] = [];

  afterAll(() => {
    rmDirBestEffort(tmp);
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
  });

  function runUserPromptSubmit(sessionId: string | undefined) {
    const payload: Record<string, unknown> = { prompt: 'Update [[feature]]' };
    if (sessionId !== undefined) payload.session_id = sessionId;
    const result = spawnSync(
      process.execPath,
      [cliPath, 'hook', 'claude', 'UserPromptSubmit'],
      {
        cwd: caseDir,
        encoding: 'utf-8',
        input: JSON.stringify(payload),
        env: {
          ...process.env,
          PATH: '',
          CQ_LOCAL_DB_PATH: dbPath,
          HOME: emptyHome,
          USERPROFILE: emptyHome,
        },
      },
    );
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  // @lat: [[knowledge-session#Cross-process session federation#Federates once per session across two processes, and again in a different session]]
  it('federates a document once per session across two separate hook processes, and again in a different session', () => {
    const sessionA = `e2e-a-${Date.now()}-${Math.random()}`;
    const sessionB = `e2e-b-${Date.now()}-${Math.random()}`;
    sessionDirs.push(markerDirFor(sessionA), markerDirFor(sessionB));

    const first = runUserPromptSubmit(sessionA);
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain('lat.md/feature.md (run-pin, carry):');

    // Same session, second (fresh) process: already federated, so the block
    // must not repeat.
    const second = runUserPromptSubmit(sessionA);
    expect(second.stderr).toBe('');
    expect(second.stdout).not.toContain('lat.md/feature.md (run-pin, carry):');

    // A different session has no shared marker state, so the document
    // federates again.
    const third = runUserPromptSubmit(sessionB);
    expect(third.stderr).toBe('');
    expect(third.stdout).toContain('lat.md/feature.md (run-pin, carry):');
  });

  // @lat: [[knowledge-session#Cross-process session federation#Federates normally with no session id in the payload]]
  it('federates normally when the payload carries no session id', () => {
    const result = runUserPromptSubmit(undefined);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('lat.md/feature.md (run-pin, carry):');
  });
});
