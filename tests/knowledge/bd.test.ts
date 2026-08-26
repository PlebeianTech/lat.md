import { describe, it, expect, afterEach } from 'vitest';
import { join, delimiter } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmDirBestEffort } from '../util.js';
import { bdStore } from '../../src/knowledge/bd.js';

const dirsToClean: string[] = [];
const origPath = process.env.PATH;
const origPathCased = process.env.Path;

afterEach(() => {
  for (const d of dirsToClean.splice(0)) rmDirBestEffort(d);
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origPathCased === undefined) delete process.env.Path;
  else process.env.Path = origPathCased;
});

/**
 * Build a fake `bd` on PATH whose `memories --json <term>` subcommand looks
 * up `term` in `table` and prints the JSON (or the literal string given, to
 * simulate malformed output / non-zero exit). Mirrors tests/hook.test.ts's
 * makeFakeGitDir: a POSIX shell script + a Windows .cmd shim, both driven by
 * a small Node dispatcher script so the lookup logic runs once, cross-platform.
 */
function makeFakeBdDir(behavior: {
  table?: Record<string, Record<string, string>>;
  raw?: string; // used verbatim instead of `table`, for bad-JSON cases
  exitCode?: number;
  sleepMs?: number; // delay before responding, to test concurrency/timeout
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-bd-'));
  const dispatcherPath = join(dir, 'dispatch.cjs');
  writeFileSync(
    dispatcherPath,
    `
const table = ${JSON.stringify(behavior.table ?? {})};
const raw = ${JSON.stringify(behavior.raw ?? null)};
const exitCode = ${behavior.exitCode ?? 0};
const sleepMs = ${behavior.sleepMs ?? 0};
const term = process.argv[process.argv.length - 1];
function respond() {
  if (raw !== null) {
    process.stdout.write(raw);
  } else {
    process.stdout.write(JSON.stringify(table[term] ?? {}));
  }
  process.exitCode = exitCode;
}
if (sleepMs > 0) {
  setTimeout(respond, sleepMs);
} else {
  respond();
}
`,
  );

  const shScript = join(dir, 'bd');
  writeFileSync(
    shScript,
    `#!/bin/sh\nexec node "$(dirname "$0")/dispatch.cjs" "$@"\n`,
  );
  chmodSync(shScript, 0o755);

  const cmdScript = join(dir, 'bd.cmd');
  writeFileSync(cmdScript, `@node "%~dp0dispatch.cjs" %*\r\n`);

  return dir;
}

function withFakeBdOnPath(dir: string): void {
  const orig = process.env.PATH ?? process.env.Path ?? '';
  delete process.env.Path;
  process.env.PATH = dir + delimiter + orig;
}

function withNoBdOnPath(): void {
  // A dir with nothing in it: PATH resolution fails, spawnSync yields ENOENT.
  const empty = mkdtempSync(join(tmpdir(), 'lat-nobd-'));
  dirsToClean.push(empty);
  delete process.env.Path;
  process.env.PATH = empty;
}

describe('bdStore', () => {
  it('returns hits for a single matching term', async () => {
    const dir = makeFakeBdDir({
      table: { widget: { 'mem-1': 'first line\nsecond line' } },
    });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const hits = await bdStore.query({
      terms: ['widget'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      store: 'bd',
      key: 'mem-1',
      title: 'mem-1',
      detail: 'first line',
      score: 1,
    });
  });

  it('ranks a key matched by two terms above one matched by one', async () => {
    const dir = makeFakeBdDir({
      table: {
        alpha: { 'mem-a': 'a content', 'mem-both': 'both content' },
        beta: { 'mem-both': 'both content', 'mem-b': 'b content' },
      },
    });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const hits = await bdStore.query({
      terms: ['alpha', 'beta'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    expect(hits[0].key).toBe('mem-both');
    expect(hits[0].score).toBe(2);
    expect(hits.map((h) => h.key)).toContain('mem-a');
    expect(hits.map((h) => h.key)).toContain('mem-b');
  });

  it('respects limit', async () => {
    const dir = makeFakeBdDir({
      table: { x: { m1: 'c1', m2: 'c2', m3: 'c3' } },
    });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const hits = await bdStore.query({
      terms: ['x'],
      projectRoot: '/irrelevant',
      limit: 2,
    });

    expect(hits).toHaveLength(2);
  });

  it('keeps first-seen order among ties', async () => {
    // All three terms return the same three keys with equal counts (1 each
    // by symmetric design below), so the sort must not disturb the order the
    // keys were first encountered in (term order: t1, t2, t3).
    const dir = makeFakeBdDir({
      table: {
        t1: { first: 'c', second: 'c' },
        t2: { third: 'c' },
      },
    });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const hits = await bdStore.query({
      terms: ['t1', 't2'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    // first and second both come from t1 (score 1 each, tie), third from t2.
    expect(hits.map((h) => h.key)).toEqual(['first', 'second', 'third']);
  });

  it('returns [] without throwing when bd is not on PATH', async () => {
    withNoBdOnPath();

    const hits = await bdStore.query({
      terms: ['anything'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('returns [] when bd exits non-zero', async () => {
    const dir = makeFakeBdDir({ raw: '{}', exitCode: 1 });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const hits = await bdStore.query({
      terms: ['x'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('returns [] when bd prints invalid JSON', async () => {
    const dir = makeFakeBdDir({ raw: 'not json{{{' });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const hits = await bdStore.query({
      terms: ['x'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('writes nothing to stdout or stderr on any failure path', async () => {
    const writeSpyOut: string[] = [];
    const writeSpyErr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      writeSpyOut.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      writeSpyErr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      withNoBdOnPath();
      await bdStore.query({
        terms: ['x'],
        projectRoot: '/irrelevant',
        limit: 10,
      });

      const dir = makeFakeBdDir({ raw: 'garbage' });
      dirsToClean.push(dir);
      withFakeBdOnPath(dir);
      await bdStore.query({
        terms: ['y'],
        projectRoot: '/irrelevant',
        limit: 10,
      });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    expect(writeSpyOut).toEqual([]);
    expect(writeSpyErr).toEqual([]);
  });
});

// A tag reaches this store straight from repository frontmatter, so the term
// is attacker-controlled whenever `lat` runs in a repo nobody here owns. A NUL
// byte in an argv entry makes spawnSync THROW (ERR_INVALID_ARG_VALUE) rather
// than report the failure through `result.error` — verified — so the per-term
// guard alone did not hold the "never throws" contract.
describe('bdStore: the never-throws contract', () => {
  it('returns [] for a term that makes spawnSync throw', async () => {
    const withNul = 'ab' + String.fromCharCode(0) + 'cd';
    await expect(
      bdStore.query({ terms: [withNul], projectRoot: process.cwd(), limit: 3 }),
    ).resolves.toEqual([]);
  });
});

// lat-t1y.22: bd.ts moved from spawnSync to async execFile specifically so
// per-term subprocess calls (and, at the federateTags level, the three
// stores) can overlap instead of serializing on the event loop.
describe('bdStore: per-term concurrency', () => {
  // @lat: [[knowledge-store#bd store concurrency#Answers three terms well under the time three serial calls would take]]
  it('answers three terms well under the time three serial calls would take', async () => {
    const delayMs = 500;
    const dir = makeFakeBdDir({
      table: { t1: { m1: 'c1' }, t2: { m2: 'c2' }, t3: { m3: 'c3' } },
      sleepMs: delayMs,
    });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    // Calibrate against this machine's real cost for a single call. An
    // absolute millisecond bound is not stable here: spawning three processes
    // on a loaded box can cost more than the delay they overlap, which fails
    // the test while the concurrency it checks is working perfectly. A
    // baseline measured under the same load moves with it.
    //
    // Warm up first, and discard it. The very first spawn pays PATH lookup and
    // interpreter start-up that later calls do not, and a baseline inflated by
    // that one-off cost lifts the threshold above the serial floor — which
    // makes this test pass even when the calls run one after another, proving
    // nothing. Verified: without this warm-up, a deliberately serialized
    // implementation still passed.
    await bdStore.query({
      terms: ['t1'],
      projectRoot: '/irrelevant',
      limit: 10,
    });

    const oneStart = Date.now();
    await bdStore.query({
      terms: ['t1'],
      projectRoot: '/irrelevant',
      limit: 10,
    });
    const oneCall = Date.now() - oneStart;

    const start = Date.now();
    const hits = await bdStore.query({
      terms: ['t1', 't2', 't3'],
      projectRoot: '/irrelevant',
      limit: 10,
    });
    const elapsed = Date.now() - start;

    expect(hits).toHaveLength(3);
    // Serial calls would land near 3x the single-call cost. Concurrent ones
    // stay near 1x plus the two extra spawns. The bound sits between the two
    // so a regression to serial still fails loudly.
    expect(elapsed).toBeLessThan(oneCall * 2.5);
  });

  // @lat: [[knowledge-store#bd store concurrency#Abandons a call that exceeds the per-call timeout]]
  it('abandons a call that exceeds the per-call timeout rather than waiting for it', async () => {
    // CALL_TIMEOUT_MS in bd.ts is 2000ms; sleep well past it so a hang would
    // be obvious, but bound the assertion well under 2x so this test proves
    // the timeout actually fires rather than merely being slow.
    const dir = makeFakeBdDir({
      table: { slow: { m1: 'c1' } },
      sleepMs: 5000,
    });
    dirsToClean.push(dir);
    withFakeBdOnPath(dir);

    const start = Date.now();
    const hits = await bdStore.query({
      terms: ['slow'],
      projectRoot: '/irrelevant',
      limit: 10,
    });
    const elapsed = Date.now() - start;

    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(3500);
  }, 10000);
});
