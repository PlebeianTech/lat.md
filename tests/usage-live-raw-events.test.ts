import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  sources: [] as unknown[],
  snapshot: null as unknown,
  createBdWatcher: vi.fn(),
}));
vi.mock('../src/fork/usage/sources/index.js', () => ({
  sessionSources: fakes.sources,
}));
vi.mock('../src/fork/usage/bd-attribution.js', async (original) => ({
  ...(await original<object>()),
  createBdWatcher: fakes.createBdWatcher,
}));
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { startViewServer, type ViewServer } from '../src/view/server.js';
import {
  checkUsageLive,
  configureUsageLive,
  stopUsageLive,
  usageLiveStatus,
} from '../src/fork/usage/live.js';
import {
  queryUsageEvents,
  type RawEventsPage,
  type RawFacet,
} from '../src/fork/usage/event-index.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import type { SessionSource } from '../src/fork/usage/sources/types.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let counter = 0;
function usage(fields: Partial<UsageEvent> = {}): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${String(counter).padStart(4, '0')}`,
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

function session(
  kind: SessionEvent['kind'],
  sessionId: string,
  minutes: number,
  extra: Record<string, unknown> = {},
): SessionEvent {
  counter++;
  return {
    kind,
    event_id: `s${String(counter).padStart(4, '0')}`,
    session_id: sessionId,
    ts: at(minutes),
    source: { path: `/fake/${sessionId}.jsonl`, offset: counter },
    ...extra,
  } as SessionEvent;
}

/** A reader that finds no events in any transcript. */
const readNothing: SessionSource['read'] = async (_path, checkpoint) => ({
  events: [],
  checkpoint: checkpoint ?? { offset: 0 },
  reason: null,
});

function claudeSource(events: SessionEvent[]): SessionSource {
  return {
    agent: 'claude',
    discover: async () => ['/fake/claude.jsonl'],
    read: async (_path, checkpoint) => ({
      events: events.slice(checkpoint?.offset ?? 0),
      checkpoint: { offset: events.length },
      reason: null,
    }),
  };
}

const issue = (id: string, parent?: string) => ({
  id,
  title: `title ${id}`,
  status: 'open',
  issue_type: parent ? 'task' : 'epic',
  created_at: at(-1000),
  ...(parent ? { parent } : {}),
});
const SNAPSHOT: BdSnapshot = {
  issues: [issue('lat-1'), issue('lat-1.1', 'lat-1'), issue('lat-2')],
  discoveredFrom: [],
  reopens: [],
};

const PAGE =
  '<!doctype html><html><head><script src="./assets/usage.js"></script></head><body>usage</body></html>';

let root: string;
let server: ViewServer;

beforeEach(async () => {
  counter = 0;
  root = mkdtempSync(join(tmpdir(), 'lat-usage-raw-'));
  const latDir = join(root, 'lat.md');
  const clientDir = join(root, 'client');
  mkdirSync(latDir);
  mkdirSync(clientDir);
  writeFileSync(join(latDir, 'lat.md'), '# Project\n');
  writeFileSync(join(clientDir, 'usage.html'), PAGE);
  fakes.sources.length = 0;
  fakes.snapshot = SNAPSHOT;
  fakes.createBdWatcher.mockReset();
  fakes.createBdWatcher.mockImplementation(() => ({
    refresh: vi.fn(async () => fakes.snapshot),
  }));
  configureUsageLive({ contributions: [], pollMs: 20, heartbeatMs: 20 });
  server = await startViewServer(
    { projectRoot: root, latDir, mode: 'cli', styler: plainStyler },
    { port: 0, watch: false, git: false, clientDir },
  );
});

afterEach(async () => {
  stopUsageLive();
  await server.close();
  configureUsageLive({});
  rmSync(root, { recursive: true, force: true });
});

async function get(query = '') {
  const response = await fetch(`${server.url}api/usage/raw${query}`);
  return { status: response.status, text: await response.text() };
}

async function page(query = '') {
  const { status, text } = await get(query);
  expect(status).toBe(200);
  return JSON.parse(text) as RawEventsPage;
}

async function facet(field: string, query = '') {
  const { status, text } = await get(`?facet=${field}${query}`);
  expect(status).toBe(200);
  return JSON.parse(text) as RawFacet;
}

const ids = (result: RawEventsPage) => result.records.map((r) => r.id);

/**
 * Session A (claude, named "my session") claims lat-1.1 at minute 0 and works
 * until the next day. Session B (codex) has no claim.
 */
function scenario() {
  fakes.sources.push(
    claudeSource([
      session('session_name', 'A', 0, { name: 'my session' }),
      session('bd_command', 'A', 0, {
        verb: 'claim',
        issue_id: 'lat-1.1',
      }),
      session('token_usage', 'A', 1.5, {
        usage: {
          input: 10,
          output: 5,
          cache_read: null,
          cache_write: null,
          reasoning: null,
        },
      }),
      session('tool_call', 'A', 2.5, {
        tool: {
          name: 'Bash',
          action: 'shell',
          path: null,
          bytes: null,
          shell: {
            command: 'cat secret-transcript-text',
            exit_code: { value: 0 },
          },
        },
      }),
    ]),
  );
  const events = [
    usage({ event_id: 'a1', ts: at(1) }),
    usage({
      event_id: 'a2',
      ts: at(2),
      command: 'section',
      section_id: 'docs/a#One',
    }),
    usage({
      event_id: 'a3',
      ts: at(3),
      exit_code: 1,
      error_class: 'usage',
    }),
    usage({ event_id: 'b1', ts: at(1), agent: 'codex', session_id: 'B' }),
    usage({
      event_id: 'b2',
      ts: at(2),
      agent: 'codex',
      session_id: 'B',
      command: 'hook',
      surface: 'hook',
      caller: 'hook-injected',
      injected_bytes: 40,
    }),
    usage({ event_id: 'a4', ts: at(1500) }),
  ];
  for (const event of events) writeUsageEvent(root, event);
}

function countDiscoveries() {
  const claude = vi.fn(async () => ['/fake/claude.jsonl']);
  const codex = vi.fn(async () => []);
  fakes.sources.push(
    { agent: 'claude', discover: claude, read: readNothing },
    { agent: 'codex', discover: codex, read: readNothing },
  );
  configureUsageLive({
    contributions: [],
    pollMs: 60_000,
    heartbeatMs: 60_000,
  });
  writeUsageEvent(root, usage());
  return () => [claude.mock.calls.length, codex.mock.calls.length];
}

describe('usage raw events endpoint', () => {
  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Records match the shared filters]]
  it('filters by agent, session, time range and issue with descendants', async () => {
    scenario();
    const everything = await page();
    expect(everything.records).toHaveLength(10);
    expect(everything.records.filter((r) => r.type === 'usage')).toHaveLength(
      6,
    );

    const codex = await page('?agent=codex');
    expect(ids(codex).sort()).toEqual(['b1', 'b2']);

    expect(ids(await page('?session=B')).sort()).toEqual(['b1', 'b2']);
    const named = await page('?session=my%20session');
    expect(new Set(named.records.map((r) => r.session_id))).toEqual(
      new Set(['A']),
    );
    expect(named.records).toHaveLength(8);

    expect(ids(await page('?from=2026-11-09')).sort()).toEqual(['a4']);
    const firstDay = await page('?to=2026-11-08&agent=claude');
    expect(firstDay.records.some((r) => r.id === 'a4')).toBe(false);
    expect(firstDay.records).toHaveLength(7);

    const child = await page('?issue=lat-1.1');
    const parent = await page('?issue=lat-1');
    expect(ids(parent)).toEqual(ids(child));
    expect(child.records.length).toBeGreaterThan(0);
    expect(child.records.every((r) => r.issue_ids.includes('lat-1.1'))).toBe(
      true,
    );
    expect(ids(child)).not.toContain('b1');
    expect(ids(await page('?issue=lat-2'))).toEqual([]);

    const b1 = everything.records.find((r) => r.id === 'b1')!;
    expect(b1.issue_ids).toEqual([]);
    expect(b1.attribution).toBe('unattributed');
    const a2 = everything.records.find((r) => r.id === 'a2')!;
    expect(a2.attribution).toBe('claim');

    const bad = await get('?from=yesterday');
    expect(bad.status).toBe(400);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Records come back newest first with a cursor]]
  it('pages newest first with no duplicates or gaps', async () => {
    scenario();
    const all = await page();
    const stamps = all.records.map((r) => Date.parse(r.ts));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    expect(all.next_cursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next: RawEventsPage = await page(
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(next.records.length).toBeLessThanOrEqual(3);
      seen.push(...ids(next));
      cursor = next.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toEqual(ids(all));
    expect(new Set(seen).size).toBe(seen.length);

    expect((await get('?cursor=nonsense')).status).toBeGreaterThanOrEqual(400);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#A session event without a readable time is dropped]]
  it('drops a session event whose ts cannot be read and pages the rest', async () => {
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    const good = [1, 2, 3, 4, 5].map((m) => session('token_usage', 'A', m));
    fakes.sources.push(
      claudeSource([{ ...session('token_usage', 'A', 0), ts: '' }, ...good]),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next: RawEventsPage = await page(
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...ids(next));
      cursor = next.next_cursor;
    } while (cursor);
    expect(seen).toEqual(good.map((e) => e.event_id).reverse());
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Turning usage off empties the index]]
  it('lists no records after usage is disabled and lists them again on enable', async () => {
    writeUsageEvent(root, usage({ ts: at(0) }));
    const before = ids(await page());
    expect(before).toHaveLength(1);
    const dir = join(root, '.lat', 'usage');
    renameSync(dir, `${dir}.disabled`);
    expect(ids(await page())).toEqual([]);
    renameSync(`${dir}.disabled`, dir);
    expect(ids(await page())).toEqual(before);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#The page is capped at 200 records]]
  it('caps a page at 200 records', async () => {
    for (let i = 0; i < 250; i++) writeUsageEvent(root, usage({ ts: at(i) }));
    const defaults = await page();
    expect(defaults.records).toHaveLength(200);
    expect(defaults.next_cursor).not.toBeNull();
    expect((await page('?limit=1000')).records).toHaveLength(200);
    const rest = await page(
      `?cursor=${encodeURIComponent(defaults.next_cursor!)}`,
    );
    expect(rest.records).toHaveLength(50);
    expect(rest.next_cursor).toBeNull();
    expect((await get('?limit=0')).status).toBeGreaterThanOrEqual(400);
    expect((await get('?limit=abc')).status).toBeGreaterThanOrEqual(400);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Ids load evidence]]
  it('loads records by id through the filters and limits ids to 50', async () => {
    scenario();
    const found = await page('?ids=a2,b1,missing');
    expect(ids(found).sort()).toEqual(['a2', 'b1']);
    expect(ids(await page('?ids=a2,b1&agent=codex'))).toEqual(['b1']);
    const many = Array.from({ length: 51 }, (_, i) => `x${i}`).join(',');
    expect((await get(`?ids=${many}`)).status).toBeGreaterThanOrEqual(400);
    const fifty = Array.from({ length: 50 }, (_, i) => `x${i}`).join(',');
    expect((await get(`?ids=${fifty}`)).status).toBe(200);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Facets count a field over the filtered set]]
  it('counts the top values of each allowed field', async () => {
    scenario();
    expect(await facet('command')).toEqual({
      field: 'command',
      values: [
        { value: 'search', count: 4 },
        { value: 'hook', count: 1 },
        { value: 'section', count: 1 },
      ],
      missing: 0,
      unknown: 0,
      lacking: 4,
    });
    expect((await facet('agent')).values).toEqual([
      { value: 'claude', count: 8 },
      { value: 'codex', count: 2 },
    ]);
    expect((await facet('caller')).values).toEqual([
      { value: 'agent', count: 5 },
      { value: 'hook-injected', count: 1 },
    ]);
    expect((await facet('surface')).values).toEqual([
      { value: 'cli', count: 5 },
      { value: 'hook', count: 1 },
    ]);
    expect((await facet('session_id')).values).toEqual([
      { value: 'A', count: 8 },
      { value: 'B', count: 2 },
    ]);
    const sections = await facet('section_id');
    expect(sections.values).toEqual([{ value: 'docs/a#One', count: 1 }]);
    expect(sections.missing).toBe(5);
    const errors = await facet('error_class');
    expect(errors.values).toEqual([{ value: 'usage', count: 1 }]);
    expect(errors.missing).toBe(5);
    expect((await facet('exit_code')).values).toEqual([
      { value: 0, count: 5 },
      { value: 1, count: 1 },
    ]);
    expect((await facet('command', '&agent=codex')).values).toEqual([
      { value: 'hook', count: 1 },
      { value: 'search', count: 1 },
    ]);
    for (const field of ['issue', 'query', 'nonsense'])
      expect((await get(`?facet=${field}`)).status).toBeGreaterThanOrEqual(400);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Field filters and the query filter narrow records and facets]]
  it('filters records and facets by field values and by query text', async () => {
    scenario();
    writeUsageEvent(
      root,
      usage({ event_id: 'q1', ts: at(4), query: 'how to check', found: true }),
    );
    writeUsageEvent(
      root,
      usage({
        event_id: 'q2',
        ts: at(5),
        query: 'other',
        unknown_reasons: { error_class: 'not_captured' },
      }),
    );
    const both = await page('?where.command=section&where.command=hook');
    expect(ids(both).sort()).toEqual(['a2', 'b2']);
    expect(ids(await page('?where.command=search&where.agent=codex'))).toEqual([
      'b1',
    ]);
    expect(ids(await page('?where.exit_code=1'))).toEqual(['a3']);
    expect(ids(await page('?where.session_id=B&agent=codex')).sort()).toEqual([
      'b1',
      'b2',
    ]);
    // a session event has no command, so it never matches a command value
    expect(
      (await page('?where.command=search')).records.every(
        (r) => r.type === 'usage',
      ),
    ).toBe(true);
    expect(ids(await page('?query=how%20to%20check'))).toEqual(['q1']);
    expect(ids(await page('?query=how')).length).toBe(0);
    expect(ids(await page('?query=other&where.command=search'))).toEqual([
      'q2',
    ]);
    const paged = await page('?where.command=search&limit=2');
    expect(paged.records).toHaveLength(2);
    expect(paged.next_cursor).not.toBeNull();
    // the total counts every match, on every page
    expect(paged.total).toBe(6);
    const rest = await page(
      `?where.command=search&limit=2&cursor=${encodeURIComponent(paged.next_cursor!)}`,
    );
    expect(rest.total).toBe(6);
    expect((await page('?where.agent=codex')).total).toBe(2);

    // a facet counts the filtered records and splits unknown from missing
    const sections = await facet('command', '&where.agent=codex');
    expect(sections.values).toEqual([
      { value: 'hook', count: 1 },
      { value: 'search', count: 1 },
    ]);
    const errors = await facet('error_class', '&query=other');
    expect(errors).toMatchObject({ values: [], missing: 0, unknown: 1 });
    expect(await facet('error_class', '&where.agent=claude')).toMatchObject({
      unknown: 1,
      lacking: 4,
    });
    expect(await facet('error_class', '&where.agent=codex')).toMatchObject({
      unknown: 0,
      lacking: 0,
    });

    for (const bad of ['where.nonsense=x', 'where.issue=lat-1'])
      expect((await get(`?${bad}`)).status).toBeGreaterThanOrEqual(400);
  });

  it('returns at most 20 facet values', async () => {
    for (let i = 0; i < 25; i++)
      writeUsageEvent(
        root,
        usage({ command: `cmd${String(i).padStart(2, '0')}` }),
      );
    expect((await facet('command')).values).toHaveLength(20);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#One bd watcher serves the summary and the index]]
  it('makes one bd watcher for the summary and the raw index of a root', async () => {
    scenario();
    const summary = await fetch(`${server.url}api/usage`);
    expect(summary.status).toBe(200);
    await page();
    await facet('command');
    expect(fakes.createBdWatcher).toHaveBeenCalledTimes(1);
    expect(
      fakes.createBdWatcher.mock.results[0].value.refresh,
    ).toHaveBeenCalled();
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Findings share the watcher of the root]]
  it('makes one bd watcher when the findings route is requested first', async () => {
    scenario();
    const findings = await fetch(`${server.url}api/usage/findings`);
    expect(findings.status).toBe(200);
    await page();
    expect(fakes.createBdWatcher).toHaveBeenCalledTimes(1);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#A restarted server hands the index its new watcher]]
  it('reads the bd watcher of the restarted live server, not the stopped one', async () => {
    scenario();
    await page();
    stopUsageLive(root);
    const [stopped] = fakes.createBdWatcher.mock.results.map((r) => r.value);
    stopped.refresh.mockClear();
    await page();
    expect(fakes.createBdWatcher).toHaveBeenCalledTimes(2);
    const restarted = fakes.createBdWatcher.mock.results[1].value;
    expect(restarted.refresh).toHaveBeenCalled();
    expect(stopped.refresh).not.toHaveBeenCalled();
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Raw and findings requests share the discovery of a change]]
  it('discovers each source once for the raw and findings requests that follow a change', async () => {
    const discoveries = countDiscoveries();
    await page();
    const before = discoveries();
    const checking = checkUsageLive(root);
    const statuses = await Promise.all([
      ...Array.from({ length: 10 }, () => get().then((r) => r.status)),
      fetch(`${server.url}api/usage/findings`).then((r) => r.status),
    ]);
    await checking;
    expect(statuses).toEqual(Array(11).fill(200));
    expect(discoveries()).toEqual(before.map((calls) => calls + 1));
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Raw and findings requests share the discovery of a change]]
  it('discovers each source once when the findings request is the first to read the index', async () => {
    const discoveries = countDiscoveries();
    expect((await fetch(`${server.url}api/usage`)).status).toBe(200);
    const before = discoveries();
    await checkUsageLive(root);
    const findings = await fetch(`${server.url}api/usage/findings`);
    expect(findings.status).toBe(200);
    expect(discoveries()).toEqual(before.map((calls) => calls + 1));
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#A restarted server hands the index its new sources]]
  it('lists the session files the restarted live server found, not the stopped one', async () => {
    const one = session('session_name', 'A', 0, { name: 'one' });
    const two = session('session_name', 'B', 1, { name: 'two' });
    const files: Record<string, SessionEvent[]> = {
      '/fake/one.jsonl': [one],
      '/fake/two.jsonl': [two],
    };
    const found = ['/fake/one.jsonl'];
    const source: SessionSource = {
      agent: 'claude',
      discover: async () => [...found],
      read: async (path, checkpoint) => ({
        events: files[path].slice(checkpoint?.offset ?? 0),
        checkpoint: { offset: files[path].length },
        reason: null,
      }),
    };
    fakes.sources.push(source);
    configureUsageLive({
      contributions: [],
      pollMs: 60_000,
      heartbeatMs: 60_000,
    });
    writeUsageEvent(root, usage());
    const sessionIds = async () =>
      (await page()).records
        .filter((r) => r.type === 'session')
        .map((r) => r.id);
    expect(await sessionIds()).toEqual([one.event_id]);
    stopUsageLive(root);
    found.push('/fake/two.jsonl');
    expect(await sessionIds()).toEqual([two.event_id, one.event_id]);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#An index without a live server discovers on the raw sources]]
  it('calls discover on the raw sources for every read when no live server feeds the index', async () => {
    const discover = vi.fn(async () => []);
    fakes.sources.push({ agent: 'claude', discover, read: readNothing });
    writeUsageEvent(root, usage());
    const bd = { refresh: async () => null };
    await queryUsageEvents({}, { root, bd });
    await queryUsageEvents({}, { root, bd });
    expect(usageLiveStatus(root).watching).toBe(false);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledWith(root);
  });

  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Records hold pointers, not transcript text]]
  it('returns pointers and no shell command, and writes no file', async () => {
    scenario();
    const result = await get();
    expect(result.text).not.toContain('secret-transcript-text');
    const tool = (JSON.parse(result.text) as RawEventsPage).records.find(
      (r) => r.type === 'session' && r.event.kind === 'tool_call',
    )!;
    expect(tool.event).toMatchObject({
      tool: { name: 'Bash', shell: { exit_code: { value: 0 } } },
      source: { path: '/fake/A.jsonl' },
    });
    expect(
      readdirSync(join(root, '.lat', 'usage')).filter(
        (name) =>
          !/^events-.*\.jsonl$/.test(name) &&
          name !== 'state.json' &&
          name !== '.gitignore',
      ),
    ).toEqual([]);
  });
});
