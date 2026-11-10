import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beadsDirFingerprint } from '../src/fork/usage/bd-client.js';

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

  // @lat: [[usage-bd-client#Usage bd Client#An unreadable store gives an empty fingerprint]]
  it('gives an empty fingerprint for an unset or unreadable store', () => {
    expect(beadsDirFingerprint(undefined)).toBe('');
    expect(beadsDirFingerprint(join(store, 'missing'))).toBe('');
  });
});
