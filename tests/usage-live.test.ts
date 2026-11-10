import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type ClientRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const forgotten = vi.hoisted(() => vi.fn());
vi.mock('../src/fork/usage/graph-snapshot.js', async (original) => ({
  ...(await original<object>()),
  forgetSnapshots: forgotten,
}));
// Every test injects its bd watcher, except the one that checks what a live
// server builds for itself.
const createdWatcher = vi.hoisted(() => vi.fn());
vi.mock('../src/fork/usage/bd-attribution.js', async (original) => ({
  ...(await original<object>()),
  createBdWatcher: createdWatcher,
}));
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { startViewServer, type ViewServer } from '../src/view/server.js';
import {
  checkUsageLive,
  configureUsageLive,
  registerUsageRoute,
  shareDiscovery,
  stopUsageLive,
  usageLiveStatus,
} from '../src/fork/usage/live.js';
import {
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type { SessionSource } from '../src/fork/usage/sources/types.js';
import { removeUsageDashboard } from '../src/fork/usage/static-export.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

registerUsageRoute('/api/usage/echo', ({ root, filters, aggregator }) => ({
  root,
  filters,
  hasSummary: typeof aggregator.summary === 'function',
}));

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let counter = 0;
function usage(fields: Partial<UsageEvent> = {}): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `live-${counter}`,
    ts: at(0),
    duration_ms: 100,
    command: 'search',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: '/repo',
    git_head: null,
    worktree: null,
    query: null,
    result_ids: [],
    result_count: null,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: 0,
    error_class: null,
    unknown_reasons: {},
    ...fields,
  };
}

/** A reader that finds no events in any transcript. */
const readNothing: SessionSource['read'] = async (_path, checkpoint) => ({
  events: [],
  checkpoint: checkpoint ?? { offset: 0 },
  reason: null,
});

const PAGE =
  '<!doctype html><html><head><script src="./assets/usage.js"></script></head><body>usage</body></html>';

let root: string;
let server: ViewServer;
const streams: ClientRequest[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lat-usage-live-'));
  const latDir = join(root, 'lat.md');
  const clientDir = join(root, 'client');
  mkdirSync(latDir);
  mkdirSync(clientDir);
  writeFileSync(join(latDir, 'lat.md'), '# Project\n');
  writeFileSync(join(clientDir, 'usage.html'), PAGE);
  configureUsageLive({
    sources: [],
    bd: { refresh: async () => null },
    contributions: [],
    pollMs: 20,
    heartbeatMs: 20,
  });
  server = await startViewServer(
    { projectRoot: root, latDir, mode: 'cli', styler: plainStyler },
    { port: 0, watch: false, git: false, clientDir },
  );
});

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.destroy();
  stopUsageLive();
  forgotten.mockClear();
  createdWatcher.mockReset();
  await server.close();
  configureUsageLive({});
  delete process.env.BEADS_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function getText(path: string) {
  const response = await fetch(server.url + path.replace(/^\//, ''));
  return { status: response.status, body: await response.text() };
}

async function getUsage(query = '') {
  const { status, body } = await getText(`/api/usage${query}`);
  return { status, json: JSON.parse(body) };
}

/** An open event stream whose received text can be awaited. */
function openStream() {
  let received = '';
  const waiting = new Set<() => void>();
  const req = request(server.url + 'api/usage/events', (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      received += chunk;
      for (const wake of waiting) wake();
    });
  });
  req.end();
  streams.push(req);
  return {
    req,
    text: () => received,
    count: (name: string) => received.split(`event: ${name}\n`).length - 1,
    until: (contains: string) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!received.includes(contains)) return false;
          waiting.delete(check);
          resolve();
          return true;
        };
        if (!check()) waiting.add(check);
      }),
  };
}

describe('usage live server', () => {
  // @lat: [[usage-live#Usage Live#Routes register through registerUsageRoute]]
  it('serves a registered route with its filters and the aggregator', async () => {
    const { status, body } = await getText('/api/usage/echo?agent=codex');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      root,
      filters: { agent: 'codex' },
      hasSummary: true,
    });
    expect(() => registerUsageRoute('/api/usage', () => null)).toThrow(
      /already registered/,
    );
  });

  // @lat: [[usage-live#Usage Live#Filters come from the query string]]
  it('narrows the aggregate by from, to and agent', async () => {
    writeUsageEvent(root, usage({ ts: '2026-11-07T12:00:00Z' }));
    writeUsageEvent(root, usage({ ts: '2026-11-08T12:00:00Z' }));
    writeUsageEvent(
      root,
      usage({ ts: '2026-11-08T13:00:00Z', agent: 'codex' }),
    );
    const all = await getUsage();
    expect(all.json.schema_version).toBe(USAGE_SCHEMA_VERSION);
    expect(all.json.totals.commands).toBe(3);
    expect((await getUsage('?from=2026-11-08')).json.totals.commands).toBe(2);
    expect((await getUsage('?to=2026-11-07')).json.totals.commands).toBe(1);
    expect(
      (await getUsage('?from=2026-11-08&agent=codex')).json.totals.commands,
    ).toBe(1);
    const bad = await getUsage('?from=yesterday');
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('Invalid from date');
  });

  // @lat: [[usage-live#Usage Live#The session rows have their own route]]
  it('serves the session rows from /api/usage/sessions, not /api/usage', async () => {
    writeUsageEvent(root, usage({ ts: '2026-11-07T12:00:00Z' }));
    writeUsageEvent(
      root,
      usage({ ts: '2026-11-08T13:00:00Z', session_id: 'other' }),
    );
    const overview = await getUsage();
    expect(overview.json).not.toHaveProperty('sessions');
    expect(overview.json.totals.commands).toBe(2);
    const all = JSON.parse((await getText('/api/usage/sessions')).body);
    expect(all.schema_version).toBe(USAGE_SCHEMA_VERSION);
    expect(all.sessions.length).toBeGreaterThan(0);
    expect(Object.keys(all).sort()).toEqual(['schema_version', 'sessions']);
    const narrowed = JSON.parse(
      (await getText('/api/usage/sessions?from=2026-11-08')).body,
    );
    expect(narrowed.sessions.length).toBeLessThan(all.sessions.length);
  });

  // @lat: [[usage-live#Usage Live#A new event is pushed once and then read]]
  it('pushes one usage-change for an appended event and then serves it', async () => {
    writeUsageEvent(root, usage());
    expect((await getUsage()).json.totals.commands).toBe(1);
    const stream = openStream();
    await stream.until('event: ready');
    expect(stream.text()).toMatch(/"instanceId":"[0-9a-f-]{36}"/);
    await stream.until(': heartbeat');
    writeUsageEvent(root, usage({ ts: at(5) }));
    await stream.until('event: usage-change');
    await checkUsageLive(root);
    expect(stream.count('usage-change')).toBe(1);
    expect((await getUsage()).json.totals.commands).toBe(2);
  });

  it('pushes when a session store changes', async () => {
    const transcript = join(root, 'sessions', 'one.jsonl');
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    mkdirSync(join(root, 'sessions'));
    writeFileSync(transcript, 'a\n');
    const source: SessionSource = {
      agent: 'claude',
      discover: async () => [transcript],
      read: async (_path, checkpoint) => ({
        events: [],
        checkpoint: checkpoint ?? { offset: 0 },
        reason: null,
      }),
    };
    configureUsageLive({
      sources: [source],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 20,
      heartbeatMs: 20,
    });
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    writeFileSync(transcript, 'a\nb\n');
    await stream.until('event: usage-change');
  });

  // @lat: [[usage-live#Usage Live#A burst of changes is one refresh]]
  it('pushes once for a burst of appended events', async () => {
    configureUsageLive({
      sources: [],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 300,
    });
    writeUsageEvent(root, usage({ ts: at(-1) }));
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    for (let minute = 0; minute < 5; minute++) {
      writeUsageEvent(root, usage({ ts: at(minute) }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await stream.until('event: usage-change');
    // A fixed settle time: nothing else may arrive for the same burst.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(stream.count('usage-change')).toBe(1);
    expect((await getUsage()).json.totals.commands).toBe(6);
  });

  // @lat: [[usage-live#Usage Live#Source discovery is reused between checks]]
  it('discovers sessions again only for a new file or a poll', async () => {
    const dir = join(root, 'sessions');
    mkdirSync(dir);
    writeFileSync(join(dir, 'one.jsonl'), 'a\n');
    const discover = vi.fn(async () =>
      readdirSync(dir).map((name) => join(dir, name)),
    );
    configureUsageLive({
      sources: [
        {
          agent: 'claude',
          discover,
          read: async (_path, checkpoint) => ({
            events: [],
            checkpoint: checkpoint ?? { offset: 0 },
            reason: null,
          }),
        },
      ],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 5,
    });
    writeUsageEvent(root, usage());
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    // A new watcher replays the creation of the directory it watches.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A change that adds no file costs no discover call, not even the refresh's.
    const base = discover.mock.calls.length;
    for (let change = 1; change <= 3; change++) {
      writeUsageEvent(root, usage());
      await vi.waitFor(
        () =>
          expect(stream.count('usage-change')).toBeGreaterThanOrEqual(change),
        { timeout: 10_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(discover.mock.calls.length - base).toBe(0);
    const pushes = stream.count('usage-change');
    writeFileSync(join(dir, 'two.jsonl'), 'b\n');
    await vi.waitFor(() =>
      expect(stream.count('usage-change')).toBeGreaterThan(pushes),
    );
  });

  // @lat: [[usage-live#Usage Live#Requests after a change share one discovery]]
  it('discovers each source once for every request that follows a change', async () => {
    const dir = join(root, 'sessions');
    mkdirSync(dir);
    writeFileSync(join(dir, 'one.jsonl'), 'a\n');
    const claude = vi.fn(async () => [join(dir, 'one.jsonl')]);
    const codex = vi.fn(async () => []);
    configureUsageLive({
      sources: [
        { agent: 'claude', discover: claude, read: readNothing },
        { agent: 'codex', discover: codex, read: readNothing },
      ],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 5,
    });
    writeUsageEvent(root, usage());
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    // A new watcher replays the creation of the directory it watches.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = [claude.mock.calls.length, codex.mock.calls.length];
    const checking = checkUsageLive(root);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => getUsage()),
    );
    await checking;
    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(claude.mock.calls.length - before[0]).toBe(1);
    expect(codex.mock.calls.length - before[1]).toBe(1);
  });

  // @lat: [[usage-live#Usage Live#A poll finds a file in a store nobody watches]]
  it('finds a session file in a new directory on the next poll', async () => {
    const stores = join(root, 'stores');
    mkdirSync(join(stores, 'a'), { recursive: true });
    writeFileSync(join(stores, 'a', 'one.jsonl'), 'a\n');
    configureUsageLive({
      sources: [
        {
          agent: 'claude',
          discover: async () =>
            readdirSync(stores).flatMap((name) =>
              readdirSync(join(stores, name)).map((file) =>
                join(stores, name, file),
              ),
            ),
          read: readNothing,
        },
      ],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 40,
      heartbeatMs: 60_000,
      debounceMs: 5,
    });
    writeUsageEvent(root, usage());
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pushes = stream.count('usage-change');
    mkdirSync(join(stores, 'b'));
    writeFileSync(join(stores, 'b', 'two.jsonl'), 'b\n');
    await vi.waitFor(
      () => expect(stream.count('usage-change')).toBeGreaterThan(pushes),
      { timeout: 10_000 },
    );
  });

  // @lat: [[usage-live#Usage Live#Usage on again discovers afresh]]
  it('discovers again once after usage is turned off and on', async () => {
    const dir = join(root, 'sessions');
    mkdirSync(dir);
    const transcript = join(dir, 'one.jsonl');
    writeFileSync(transcript, 'a\n');
    const discover = vi.fn(async () =>
      readdirSync(dir).map((name) => join(dir, name)),
    );
    configureUsageLive({
      sources: [{ agent: 'claude', discover, read: readNothing }],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 5,
    });
    vi.stubEnv('LAT_USAGE', '1');
    try {
      await getUsage();
      const stream = openStream();
      await stream.until('event: ready');
      await new Promise((resolve) => setTimeout(resolve, 200));
      vi.stubEnv('LAT_USAGE', '');
      const pushes = stream.count('usage-change');
      appendFileSync(transcript, 'b\n');
      await vi.waitFor(
        () => expect(stream.count('usage-change')).toBeGreaterThan(pushes),
        { timeout: 10_000 },
      );
      vi.stubEnv('LAT_USAGE', '1');
      writeFileSync(join(dir, 'two.jsonl'), 'b\n');
      const base = discover.mock.calls.length;
      await getUsage();
      await getUsage();
      expect(discover.mock.calls.length - base).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // @lat: [[usage-live#Usage Live#Usage off reads no session store]]
  it('discovers no session store while usage is off', async () => {
    const discover = vi.fn(async () => []);
    configureUsageLive({
      sources: [{ agent: 'claude', discover, read: vi.fn() }],
      bd: { refresh: async () => null },
      contributions: [],
      pollMs: 20,
      heartbeatMs: 20,
    });
    const stream = openStream();
    await stream.until('event: ready');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(discover).not.toHaveBeenCalled();
  });

  // @lat: [[usage-live#Usage Live#The change signature follows the resolved bd database]]
  it('pushes when the bd database changes', async () => {
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    const manifest = join(root, 'beads', 'embeddeddolt', 'db', '.dolt', 'noms');
    mkdirSync(manifest, { recursive: true });
    writeFileSync(join(manifest, 'manifest'), '1');
    process.env.BEADS_DIR = join(root, 'beads');
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    writeFileSync(join(manifest, 'manifest'), '12');
    await stream.until('event: usage-change');
  });

  // @lat: [[usage-live#Usage Live#The change signature follows the resolved bd database]]
  it('pushes when the project .beads database changes, whatever BEADS_DIR names', async () => {
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    const manifest = join(
      root,
      '.beads',
      'embeddeddolt',
      'db',
      '.dolt',
      'noms',
    );
    mkdirSync(manifest, { recursive: true });
    writeFileSync(join(manifest, 'manifest'), '1');
    // A store the project does not use: a change there must not matter.
    process.env.BEADS_DIR = join(root, 'elsewhere');
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    writeFileSync(join(manifest, 'manifest'), '12');
    await stream.until('event: usage-change');
  });

  // @lat: [[usage-live#Usage Live#Usage off watches no bd database]]
  it('pushes nothing when the project .beads database changes while usage is off', async () => {
    const manifest = join(
      root,
      '.beads',
      'embeddeddolt',
      'db',
      '.dolt',
      'noms',
    );
    mkdirSync(manifest, { recursive: true });
    writeFileSync(join(manifest, 'manifest'), '1');
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    writeFileSync(join(manifest, 'manifest'), '12');
    await checkUsageLive(root);
    const beats = () => stream.text().split(': heartbeat').length;
    const before = beats();
    // A heartbeat written after the check arrives after any push the check made.
    await vi.waitFor(() => expect(beats()).toBeGreaterThan(before));
    expect(stream.count('usage-change')).toBe(0);
  });

  // @lat: [[usage-live#Usage Live#The shared bd watcher is made for the project root]]
  it('makes the bd watcher it builds for itself for the project root', async () => {
    createdWatcher.mockReturnValue({ refresh: async () => null });
    configureUsageLive({
      sources: [],
      contributions: [],
      pollMs: 20,
      heartbeatMs: 20,
    });
    await getUsage();
    expect(createdWatcher).toHaveBeenCalledTimes(1);
    expect(createdWatcher).toHaveBeenCalledWith(root);
  });

  // @lat: [[usage-live#Usage Live#A failing refresh is pushed once]]
  it('pushes usage-error once and forgets snapshots once per head change', async () => {
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    const reflog = join(root, '.git', 'logs');
    mkdirSync(reflog, { recursive: true });
    writeFileSync(join(reflog, 'HEAD'), 'a');
    let failing = false;
    configureUsageLive({
      sources: [],
      bd: {
        refresh: async () => {
          if (failing) throw new Error('bd is down');
          return null;
        },
      },
      contributions: [],
      pollMs: 20,
      heartbeatMs: 20,
    });
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    writeFileSync(join(reflog, 'HEAD'), 'ab');
    await stream.until('event: usage-change');
    expect(forgotten).toHaveBeenCalledTimes(1);
    failing = true;
    writeFileSync(join(reflog, 'HEAD'), 'abc');
    await stream.until('event: usage-error');
    expect(stream.text()).toContain('"message":"bd is down"');
    for (let poll = 0; poll < 3; poll++) await checkUsageLive(root);
    expect(stream.count('usage-error')).toBe(1);
    expect(forgotten).toHaveBeenCalledTimes(2);
    failing = false;
    writeUsageEvent(root, usage());
    await vi.waitFor(() => expect(stream.count('usage-change')).toBe(2));
  });

  // @lat: [[usage-live#Usage Live#A project below the repository root sees head moves]]
  it('forgets snapshots when HEAD moves in a parent repository', async () => {
    const project = join(root, 'proj');
    const reflog = join(root, '.git', 'logs');
    mkdirSync(join(project, 'lat.md'), { recursive: true });
    mkdirSync(reflog, { recursive: true });
    writeFileSync(join(project, 'lat.md', 'lat.md'), '# Project\n');
    writeFileSync(join(reflog, 'HEAD'), 'a');
    const nested = await startViewServer(
      {
        projectRoot: project,
        latDir: join(project, 'lat.md'),
        mode: 'cli',
        styler: plainStyler,
      },
      { port: 0, watch: false, git: false, clientDir: join(root, 'client') },
    );
    try {
      expect((await fetch(nested.url + 'api/usage')).status).toBe(200);
      writeFileSync(join(reflog, 'HEAD'), 'ab');
      await checkUsageLive(project);
      expect(forgotten).toHaveBeenCalledTimes(1);
    } finally {
      stopUsageLive(project);
      await nested.close();
    }
  });

  // @lat: [[usage-live#Usage Live#The dashboard page is served at any depth]]
  it('serves usage.html with rewritten asset URLs at any depth', async () => {
    for (const path of ['/_usage', '/_usage/', '/_usage/sessions/x']) {
      const { status, body } = await getText(path);
      expect(status).toBe(200);
      expect(body).toContain('src="/assets/usage.js"');
    }
    expect((await getText('/_usagely')).status).toBe(404);
    rmSync(join(root, 'client', 'usage.html'));
    expect((await getText('/_usage')).status).toBe(404);
  });

  // @lat: [[usage-live#Usage Live#Documents named usage stay reachable]]
  it('leaves /usage and /usage/<doc> to the document routes', async () => {
    mkdirSync(join(root, 'lat.md', 'usage'));
    writeFileSync(join(root, 'lat.md', 'usage', 'guide.md'), '# Guide\n');
    writeFileSync(join(root, 'lat.md', 'usage.md'), '# Usage\n');
    writeFileSync(
      join(root, 'client', 'index.html'),
      '<!doctype html><html><head></head><body>app</body></html>',
    );
    await server.close();
    server = await startViewServer(
      {
        projectRoot: root,
        latDir: join(root, 'lat.md'),
        mode: 'cli',
        styler: plainStyler,
      },
      { port: 0, watch: false, git: false, clientDir: join(root, 'client') },
    );
    for (const path of ['/usage', '/usage/guide']) {
      const { status, body } = await getText(path);
      expect(status).toBe(200);
      expect(body).toContain('<body>app</body>');
      expect(body).not.toContain('usage.js');
    }
  });

  // @lat: [[usage-live#Usage Live#A restart resumes from state.json]]
  it('loses no events when the watchers stop and start again', async () => {
    writeUsageEvent(root, usage());
    await getUsage();
    const stream = openStream();
    await stream.until('event: ready');
    stream.req.destroy();
    await vi.waitFor(() => expect(usageLiveStatus(root).streams).toBe(0));
    expect(usageLiveStatus(root).watching).toBe(false);
    writeUsageEvent(root, usage({ ts: at(5) }));
    expect((await getUsage()).json.totals.commands).toBe(2);
  });

  // @lat: [[usage-live#Usage Live#Watchers follow the stream clients]]
  it('watches from the first request until the last stream closes', async () => {
    expect(usageLiveStatus(root)).toEqual({ watching: false, streams: 0 });
    await getUsage();
    expect(usageLiveStatus(root)).toEqual({ watching: true, streams: 0 });
    const first = openStream();
    const second = openStream();
    await first.until('event: ready');
    await second.until('event: ready');
    expect(usageLiveStatus(root).streams).toBe(2);
    first.req.destroy();
    await vi.waitFor(() => expect(usageLiveStatus(root).streams).toBe(1));
    expect(usageLiveStatus(root).watching).toBe(true);
    second.req.destroy();
    await vi.waitFor(() => expect(usageLiveStatus(root).streams).toBe(0));
    expect(usageLiveStatus(root).watching).toBe(false);
  });

  // @lat: [[usage-live#Usage Live#A disconnect releases its stream]]
  it('drops a disconnected stream and keeps serving the others', async () => {
    await getUsage();
    const gone = openStream();
    const stays = openStream();
    await gone.until('event: ready');
    await stays.until('event: ready');
    gone.req.destroy();
    await vi.waitFor(() => expect(usageLiveStatus(root).streams).toBe(1));
    writeUsageEvent(root, usage());
    await stays.until('event: usage-change');
    expect(gone.count('usage-change')).toBe(0);
  });
});

describe('shareDiscovery', () => {
  // @lat: [[usage-live#Usage Live#A walk in flight is shared and an invalidation is kept]]
  it('shares a walk that is running and walks again after an invalidation', async () => {
    const walks = new Map<SessionSource, Promise<string[]>>();
    const finish: Array<(paths: string[]) => void> = [];
    const discover = vi.fn(
      () => new Promise<string[]>((resolve) => finish.push(resolve)),
    );
    const [shared] = shareDiscovery(
      [{ agent: 'claude', discover, read: readNothing }],
      walks,
    );
    const early = Array.from({ length: 10 }, () => shared.discover('/repo'));
    expect(discover).toHaveBeenCalledTimes(1);
    walks.clear();
    const late = shared.discover('/repo');
    expect(discover).toHaveBeenCalledTimes(2);
    finish[0](['one']);
    finish[1](['one', 'two']);
    expect(await Promise.all(early)).toEqual(Array(10).fill(['one']));
    expect(await late).toEqual(['one', 'two']);
    expect(await shared.discover('/repo')).toEqual(['one', 'two']);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

describe('removeUsageDashboard', () => {
  // @lat: [[usage-live#Usage Live#A static export leaves the dashboard page out]]
  it('deletes usage.html from a static payload and keeps the rest', async () => {
    const payload = mkdtempSync(join(tmpdir(), 'lat-usage-static-'));
    try {
      mkdirSync(join(payload, 'assets'));
      writeFileSync(join(payload, 'index.html'), '<html></html>');
      writeFileSync(join(payload, 'usage.html'), '<html></html>');
      writeFileSync(join(payload, 'assets', 'app.js'), '');
      await removeUsageDashboard(payload);
      expect(existsSync(join(payload, 'usage.html'))).toBe(false);
      expect(existsSync(join(payload, 'index.html'))).toBe(true);
      expect(existsSync(join(payload, 'assets', 'app.js'))).toBe(true);
      await expect(removeUsageDashboard(payload)).resolves.toBeUndefined();
    } finally {
      rmSync(payload, { recursive: true, force: true });
    }
  });
});
