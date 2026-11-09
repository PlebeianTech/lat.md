import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ sources: [] as unknown[] }));
vi.mock('../src/fork/usage/sources/index.js', () => ({
  sessionSources: fakes.sources,
}));
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import { startViewServer, type ViewServer } from '../src/view/server.js';
import { configureUsageLive, stopUsageLive } from '../src/fork/usage/live.js';
import type { RawRecord } from '../src/fork/usage/event-index.js';
import {
  computeFindings,
  findingsFor,
  findingDetectors,
  MAX_EVIDENCE,
  type Finding,
  type FindingsInput,
  type FindingsResult,
} from '../src/fork/usage/findings.js';
import type { UsageSummary } from '../src/fork/usage/aggregate-types.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type { SessionSource } from '../src/fork/usage/sources/types.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const DAYS = ['2026-11-08', '2026-11-09'];

function gitInit(dir: string): string {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', [
    '-C',
    dir,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
  return dir;
}

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

function search(query: string, fields: Partial<UsageEvent> = {}): RawRecord {
  const event = usage({ query, result_count: 0, ...fields });
  return {
    id: event.event_id,
    ts: event.ts,
    agent: event.agent,
    session_id: event.session_id,
    issue_ids: [],
    attribution: 'unattributed',
    type: 'usage',
    event,
  } as RawRecord;
}

function bypass(path: string, id: string, ts: string, sessionId = 'A') {
  return {
    id,
    ts,
    agent: 'claude',
    session_id: sessionId,
    issue_ids: [],
    attribution: 'unattributed',
    type: 'session',
    event: {
      kind: 'bypass_read',
      event_id: id,
      session_id: sessionId,
      ts,
      source: { path: '/fake', offset: 0 },
      path,
      bytes: 10,
    },
  } as unknown as RawRecord;
}

function input(
  records: RawRecord[],
  extensions: Record<string, unknown> = {},
  sections: { key: string }[] = [],
): FindingsInput {
  return {
    summary: { days: DAYS, sections, extensions } as unknown as UsageSummary,
    records,
  };
}

const bySubject = (result: FindingsResult, kind: string, subject: string) =>
  result.findings.find((f) => f.kind === kind && f.subject === subject)!;

describe('usage findings engine', () => {
  // @lat: [[usage-findings#Usage Findings#Repeated empty searches group into one finding]]
  it('groups repeated empty searches by normalized query', () => {
    const result = computeFindings(
      input([
        search('Deploy  Steps', { ts: at(1), session_id: 'A' }),
        search('deploy steps', { ts: at(2), session_id: 'B' }),
        search('deploy steps', { ts: at(1500), session_id: 'B' }),
        search('deploy steps', { ts: at(3), result_count: 4 }),
        search('deploy steps', { ts: at(4), result_count: null }),
        search('other', { ts: at(5), result_count: 0, session_id: 'C' }),
      ]),
    );
    const finding = bySubject(result, 'empty-search', 'deploy steps');
    expect(finding.id).toBe('empty-search:deploy steps');
    expect(finding.count).toBe(3);
    expect(finding.sessions).toBe(2);
    expect(finding.first_seen).toBe(at(1));
    expect(finding.last_seen).toBe(at(1500));
    expect(finding.daily).toEqual([
      { day: '2026-11-08', count: 2 },
      { day: '2026-11-09', count: 1 },
    ]);
    expect(
      result.findings.filter((f) => f.kind === 'empty-search'),
    ).toHaveLength(2);
  });

  // @lat: [[usage-findings#Usage Findings#A bypassed file is a finding]]
  it('groups bypass reads by file path', () => {
    const result = computeFindings(
      input([
        bypass('lat.md/cli.md', 'b1', at(1), 'A'),
        bypass('lat.md/cli.md', 'b2', at(2), 'B'),
        bypass('lat.md/other.md', 'b3', at(3), 'A'),
      ]),
    );
    const finding = bySubject(result, 'bypassed-file', 'lat.md/cli.md');
    expect(finding.count).toBe(2);
    expect(finding.sessions).toBe(2);
    expect(finding.evidence).toEqual(['b2', 'b1']);
    expect(bySubject(result, 'bypassed-file', 'lat.md/other.md').count).toBe(1);
  });

  // @lat: [[usage-findings#Usage Findings#A never-read section is a finding]]
  it('reports the never-read sections of the snapshot and nothing when unknown', () => {
    const knowledge = {
      snapshot: {},
      never_read_sections: [
        { id: 'cli#CLI#Old', document: 'cli', bytes: 5, hash: 'h' },
      ],
    };
    const result = computeFindings(input([], { knowledge }));
    const finding = bySubject(result, 'never-read-section', 'cli#CLI#Old');
    expect(finding.id).toBe('never-read-section:cli#CLI#Old');
    expect(finding.sessions).toBe(0);
    expect(finding.evidence).toEqual([]);
    expect(finding.first_seen).toBeNull();
    expect(finding.daily.every((d) => d.count === 0)).toBe(true);

    expect(computeFindings(input([], {})).findings).toEqual([]);
    expect(
      computeFindings(input([], { knowledge: { error: 'boom' } })).findings,
    ).toEqual([]);
  });

  // @lat: [[usage-findings#Usage Findings#Findings carry counts, dates and capped evidence]]
  it('caps evidence at 50 ids, newest first, and never copies text', () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      search('missing thing', { ts: at(i), event_id: `e${i}` }),
    );
    const finding = computeFindings(input(records)).findings[0];
    expect(MAX_EVIDENCE).toBe(50);
    expect(finding.count).toBe(60);
    expect(finding.evidence).toHaveLength(50);
    expect(finding.evidence[0]).toBe('e59');
    expect(finding.evidence[49]).toBe('e10');
    expect(finding.first_seen).toBe(at(0));
    expect(finding.last_seen).toBe(at(59));
  });

  // @lat: [[usage-findings#Usage Findings#Findings are ranked by sessions then count]]
  it('ranks by sessions, then count, then id', () => {
    const records = [
      search('many sessions', { session_id: 'A' }),
      search('many sessions', { session_id: 'B' }),
      search('many hits', { session_id: 'A' }),
      search('many hits', { session_id: 'A' }),
      search('many hits', { session_id: 'A' }),
      search('b one', { session_id: 'A' }),
      search('a one', { session_id: 'A' }),
    ];
    const subjects = computeFindings(input(records)).findings.map(
      (f) => f.subject,
    );
    expect(subjects).toEqual(['many sessions', 'many hits', 'a one', 'b one']);
  });

  // @lat: [[usage-findings#Usage Findings#The closest section is suggested for an empty search]]
  it('suggests the section whose title shares the most words', () => {
    const sections = [
      { key: 'cli#CLI#Backend selection' },
      { key: 'cli#CLI#search#Backend selection for search' },
      { key: 'fork#Fork#Release' },
    ];
    const result = computeFindings(
      input([search('search backend selection'), search('zzz')], {}, sections),
    );
    const suggestion = bySubject(
      result,
      'empty-search',
      'search backend selection',
    ).suggestion;
    expect(suggestion?.section_id).toBe(
      'cli#CLI#search#Backend selection for search',
    );
    expect(suggestion?.title).toBe('Backend selection for search');
    expect(suggestion?.similarity).toBeGreaterThan(0);
    expect(bySubject(result, 'empty-search', 'zzz').suggestion).toBeNull();
  });

  // @lat: [[usage-findings#Usage Findings#Extra detectors plug in]]
  it('includes the findings of a registered detector', () => {
    const extra: Finding = {
      kind: 'stale-hot-section',
      id: 'stale-hot-section:x',
      subject: 'x',
      count: 9,
      sessions: 9,
      first_seen: null,
      last_seen: null,
      daily: [],
      evidence: [],
      suggestion: null,
    };
    const detector = { name: 'extra', detect: () => [extra] };
    findingDetectors.push(detector);
    try {
      const result = computeFindings(input([search('q')]));
      expect(result.findings.map((f) => f.id)).toEqual([
        'stale-hot-section:x',
        'empty-search:q',
      ]);
    } finally {
      findingDetectors.splice(findingDetectors.indexOf(detector), 1);
    }
  });

  // @lat: [[usage-findings#Usage Findings#A failing detector does not break the others]]
  it('isolates a throwing detector', () => {
    const detector = {
      name: 'broken',
      detect: () => {
        throw new Error('nope');
      },
    };
    findingDetectors.unshift(detector);
    try {
      const result = computeFindings(input([search('q')]));
      expect(result.errors).toEqual([{ detector: 'broken', message: 'nope' }]);
      expect(result.findings.map((f) => f.id)).toEqual(['empty-search:q']);
    } finally {
      findingDetectors.splice(findingDetectors.indexOf(detector), 1);
    }
  });
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

let root: string;
let server: ViewServer;

beforeEach(async () => {
  counter = 0;
  root = gitInit(mkdtempSync(join(tmpdir(), 'lat-usage-findings-')));
  const latDir = join(root, 'lat.md');
  const clientDir = join(root, 'client');
  mkdirSync(latDir);
  mkdirSync(clientDir);
  writeFileSync(join(latDir, 'lat.md'), '# Project\n');
  writeFileSync(join(clientDir, 'usage.html'), '<!doctype html><html></html>');
  fakes.sources.length = 0;
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
  stopUsageLive();
  await server.close();
  configureUsageLive({});
  rmSync(root, { recursive: true, force: true });
});

async function findings(query = '') {
  const response = await fetch(`${server.url}api/usage/findings${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as FindingsResult;
}

describe('usage findings endpoint', () => {
  // @lat: [[usage-findings#Usage Findings#Filters narrow the findings]]
  it('honours the shared filters', async () => {
    fakes.sources.push(
      claudeSource([
        {
          kind: 'bypass_read',
          event_id: 'byp1',
          session_id: 'A',
          ts: at(5),
          source: { path: '/fake/A.jsonl', offset: 1 },
          path: 'lat.md/cli.md',
          bytes: 3,
        } as SessionEvent,
      ]),
    );
    for (const event of [
      usage({
        event_id: 'a1',
        ts: at(1),
        query: 'nothing here',
        result_count: 0,
      }),
      usage({
        event_id: 'a2',
        ts: at(2),
        query: 'Nothing here',
        result_count: 0,
      }),
      usage({
        event_id: 'b1',
        ts: at(1500),
        query: 'nothing here',
        result_count: 0,
        agent: 'codex',
        session_id: 'B',
      }),
    ])
      writeUsageEvent(root, event);

    const all = await findings();
    expect(all.errors).toEqual([]);
    const empty = all.findings.find((f) => f.kind === 'empty-search')!;
    expect(empty.count).toBe(3);
    expect(empty.sessions).toBe(2);
    expect(empty.evidence).toEqual(['b1', 'a2', 'a1']);
    expect(all.findings.some((f) => f.kind === 'bypassed-file')).toBe(true);
    expect(all.findings[0]).toBe(all.findings.find((f) => f.id === empty.id));

    const codex = await findings('?agent=codex');
    expect(codex.findings).toHaveLength(1);
    expect(codex.findings[0].count).toBe(1);

    const firstDay = await findings('?to=2026-11-08');
    const dayOne = firstDay.findings.find((f) => f.kind === 'empty-search')!;
    expect(dayOne.count).toBe(2);
    expect(dayOne.evidence).toEqual(['a2', 'a1']);
  });
});

describe('usage findings cache', () => {
  // @lat: [[usage-findings#Usage Findings#Findings are memoized per data version]]
  it('serves a repeated request from the cache until the data changes', async () => {
    let detects = 0;
    const counting = {
      name: 'counting',
      detect: () => {
        detects++;
        return [];
      },
    };
    findingDetectors.push(counting);
    try {
      writeUsageEvent(root, usage({ event_id: 'c1', ts: at(1) }));
      const first = await findings();
      await Promise.all([findings(), findings()]);
      expect(detects).toBe(1);
      await findings('?agent=codex');
      expect(detects).toBe(2);
      writeUsageEvent(root, usage({ event_id: 'c2', ts: at(2) }));
      await findings();
      expect(detects).toBe(3);
      expect(first.errors).toEqual([]);
    } finally {
      findingDetectors.splice(findingDetectors.indexOf(counting), 1);
    }
  });
});

describe('usage findings prepare hook', () => {
  const fakeAggregator = {
    refresh: async () => undefined,
    invalidate: () => undefined,
    memo: <T>(_key: string, compute: () => Promise<T>) => compute(),
    summary: async () =>
      ({ days: DAYS, sections: [], extensions: {} }) as unknown as UsageSummary,
  };
  const index = () => {
    const root = gitInit(
      mkdtempSync(join(tmpdir(), 'lat-usage-findings-prepare-')),
    );
    mkdirSync(join(root, 'lat.md'));
    return {
      root,
      sources: [],
      bd: { refresh: async () => null },
    };
  };
  const finding = (subject: string): Finding => ({
    kind: 'probe',
    id: `probe:${subject}`,
    subject,
    count: 1,
    sessions: 1,
    first_seen: null,
    last_seen: null,
    daily: [],
    evidence: [],
    suggestion: null,
  });

  // @lat: [[usage-findings#Usage Findings#Detectors can prepare asynchronously]]
  it('awaits prepare with the root before detect reads what it loaded', async () => {
    let loaded = '';
    const options = index();
    const detector = {
      name: 'loader',
      prepare: async ({ root }: { root: string }) => {
        await Promise.resolve();
        loaded = root;
      },
      detect: () => [finding(loaded)],
    };
    findingDetectors.push(detector);
    try {
      const result = await findingsFor(fakeAggregator, {}, options);
      expect(result.findings.map((f) => f.subject)).toEqual([options.root]);
      expect(result.errors).toEqual([]);
    } finally {
      findingDetectors.splice(findingDetectors.indexOf(detector), 1);
      rmSync(options.root, { recursive: true, force: true });
    }
  });

  // @lat: [[usage-findings#Usage Findings#A failing prepare skips only its detector]]
  it('reports a throwing prepare and skips only that detector', async () => {
    const options = index();
    const broken = {
      name: 'broken-prepare',
      prepare: async () => {
        throw new Error('no graph');
      },
      detect: () => [finding('must not appear')],
    };
    const fine = { name: 'fine', detect: () => [finding('ok')] };
    findingDetectors.push(broken, fine);
    try {
      const result = await findingsFor(fakeAggregator, {}, options);
      expect(result.errors).toEqual([
        { detector: 'broken-prepare', message: 'no graph' },
      ]);
      expect(result.findings.map((f) => f.subject)).toEqual(['ok']);
    } finally {
      for (const d of [broken, fine])
        findingDetectors.splice(findingDetectors.indexOf(d), 1);
      rmSync(options.root, { recursive: true, force: true });
    }
  });
});
