import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { startViewServer, type ViewServer } from '../src/view/server.js';
import {
  checkUsageLive,
  configureUsageLive,
  registerUsageRoute,
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

  it('pushes when the bd database changes', async () => {
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

  // @lat: [[usage-live#Usage Live#A failing refresh is pushed once]]
  it('pushes usage-error once and forgets snapshots once per head change', async () => {
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
