import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beadsDirFingerprint,
  resolveBeadsDir,
} from '../src/fork/usage/bd-client.js';

let store: string;
let manifest: string;

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'lat-bd-client-'));
  const noms = join(store, 'embeddeddolt', 'lat', '.dolt', 'noms');
  mkdirSync(noms, { recursive: true });
  manifest = join(noms, 'manifest');
  writeFileSync(manifest, 'root-1');
});

afterEach(() => {
  rmSync(store, { recursive: true, force: true });
});

describe('beadsDirFingerprint', () => {
  // @lat: [[usage-bd-client#Usage bd Client#A lock file does not blank the fingerprint]]
  it('skips the .lock entry and still fingerprints the database', () => {
    const without = beadsDirFingerprint(store);
    writeFileSync(join(store, 'embeddeddolt', '.lock'), '');
    expect(beadsDirFingerprint(store)).not.toBe('');
    expect(beadsDirFingerprint(store)).toBe(without);
  });

  // @lat: [[usage-bd-client#Usage bd Client#The fingerprint follows manifest content, not mtime]]
  it('keeps the fingerprint across a same-bytes rewrite and changes it on new bytes', () => {
    const before = beadsDirFingerprint(store);
    writeFileSync(manifest, 'root-1');
    const later = new Date(Date.now() + 60_000);
    utimesSync(manifest, later, later);
    expect(beadsDirFingerprint(store)).toBe(before);

    writeFileSync(manifest, 'root-2');
    expect(beadsDirFingerprint(store)).not.toBe(before);
  });

  // @lat: [[usage-bd-client#Usage bd Client#A planted manifest link is never read]]
  it('ignores a database whose manifest is a symlink', () => {
    const target = join(store, 'target');
    writeFileSync(target, 'planted');
    const noms = join(store, 'embeddeddolt', 'planted', '.dolt', 'noms');
    mkdirSync(noms, { recursive: true });
    const before = beadsDirFingerprint(store);
    symlinkSync(target, join(noms, 'manifest'));
    expect(beadsDirFingerprint(store)).toBe(before);

    rmSync(manifest);
    expect(beadsDirFingerprint(store)).toBe('');
  });

  // @lat: [[usage-bd-client#Usage bd Client#An unreadable store gives an empty fingerprint]]
  it('gives an empty fingerprint for an unset or unreadable store', () => {
    expect(beadsDirFingerprint(undefined)).toBe('');
    expect(beadsDirFingerprint(join(store, 'missing'))).toBe('');
  });
});

describe('resolveBeadsDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lat-bd-root-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[usage-bd-client#Usage bd Client#The project database wins over BEADS_DIR]]
  it('returns the project .beads directory even when BEADS_DIR is set', () => {
    mkdirSync(join(root, '.beads'));
    expect(resolveBeadsDir(root, { BEADS_DIR: store })).toBe(
      join(root, '.beads'),
    );
    expect(resolveBeadsDir(root, {})).toBe(join(root, '.beads'));
  });

  // @lat: [[usage-bd-client#Usage bd Client#BEADS_DIR applies without a project database]]
  it('falls back to BEADS_DIR, and to nothing, when the project has no .beads directory', () => {
    expect(resolveBeadsDir(root, { BEADS_DIR: store })).toBe(store);
    expect(resolveBeadsDir(root, {})).toBeUndefined();
    expect(resolveBeadsDir(root, { BEADS_DIR: '' })).toBeUndefined();
    // A file named .beads is not a database directory.
    writeFileSync(join(root, '.beads'), '');
    expect(resolveBeadsDir(root, { BEADS_DIR: store })).toBe(store);
  });

  // @lat: [[usage-bd-client#Usage bd Client#The fingerprint follows the resolved directory]]
  it('fingerprints the project database while BEADS_DIR names another store', () => {
    const noms = join(root, '.beads', 'embeddeddolt', 'proj', '.dolt', 'noms');
    mkdirSync(noms, { recursive: true });
    writeFileSync(join(noms, 'manifest'), 'proj-1');
    const env = { BEADS_DIR: store };
    const before = beadsDirFingerprint(resolveBeadsDir(root, env));
    expect(before).toContain('proj:');
    expect(before).not.toBe(beadsDirFingerprint(store));

    // The other store changing is invisible; the project database changing is not.
    writeFileSync(manifest, 'root-2');
    expect(beadsDirFingerprint(resolveBeadsDir(root, env))).toBe(before);
    writeFileSync(join(noms, 'manifest'), 'proj-2');
    expect(beadsDirFingerprint(resolveBeadsDir(root, env))).not.toBe(before);
  });
});
