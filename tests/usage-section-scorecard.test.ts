import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAggregator } from '../src/fork/usage/aggregate.js';
import type { BdSnapshot } from '../src/fork/usage/bd-attribution.js';
import type { Contribution } from '../src/fork/usage/aggregate-types.js';
import {
  forgetSnapshots,
  type GraphSnapshot,
} from '../src/fork/usage/graph-snapshot.js';
import {
  OUTCOMES,
  forgetMissedKnowledge,
  missedKnowledgeContribution,
  type Outcome,
  type OutcomeRecord,
} from '../src/fork/usage/missed-knowledge.js';
import {
  SUGGESTED_FIXES,
  buildScorecard,
  sectionScorecardContribution,
  type ScorecardHead,
  type SectionScorecard,
} from '../src/fork/usage/section-scorecard.js';
import {
  USAGE_SCHEMA_VERSION,
  type SessionEvent,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import type {
  SessionAgent,
  SessionSource,
} from '../src/fork/usage/sources/types.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const ALPHA = 'lat.md/notes#Notes#Alpha';
const BETA = 'lat.md/notes#Notes#Beta';
const NOTES = 'lat.md/notes.md';

const DAYS = ['2026-11-08', '2026-11-09', '2026-11-10'];

let sessionCounter = 0;

function record(
  sectionId: string,
  outcome: Outcome,
  start: string | null = at(0),
): OutcomeRecord {
  sessionCounter++;
  return {
    session_id: `s${sessionCounter}`,
    section_id: sectionId,
    outcome,
    session_start: start,
    git_head: 'h1',
    queries_before_first_edit: null,
  };
}

const many = (sectionId: string, outcome: Outcome, count: number) =>
  Array.from({ length: count }, () => record(sectionId, outcome));

function snapshot(
  gitHead: string,
  sections: [id: string, hash: string][],
): GraphSnapshot {
  return {
    git_head: gitHead,
    sections: sections.map(([id, hash]) => ({
      id,
      document: `${id.split('#')[0]}.md`,
      bytes: 10,
      hash,
    })),
    documents: [{ path: NOTES, bytes: 100 }],
    code_ref_edges: [],
    code_ref_edges_reason: null,
    symbol_ref_edges: [],
  };
}

const headAt = (
  gitHead: string,
  firstTs: number,
  sections: [string, string][] | null,
  reason = 'no snapshot',
): ScorecardHead => ({
  git_head: gitHead,
  first_ts: firstTs,
  result: sections
    ? { snapshot: snapshot(gitHead, sections), reason: null }
    : { snapshot: null, reason },
});

const build = (records: OutcomeRecord[], heads: ScorecardHead[] = []) =>
  buildScorecard(records, heads, DAYS);

const rowOf = (card: SectionScorecard, id: string) =>
  card.sections.find((row) => row.section_id === id)!;

beforeEach(() => {
  sessionCounter = 0;
});

describe('usage section scorecard', () => {
  // @lat: [[usage-section-scorecard#Usage Section Scorecard#Counts and reach are per section]]
  it('counts the outcomes and the reach of each section', () => {
    const card = build([
      ...many(ALPHA, 'reached', 3),
      ...many(ALPHA, 'never-consulted', 1),
      ...many(BETA, 'bypassed', 2),
    ]);
    const alpha = rowOf(card, ALPHA);
    expect(alpha.expected).toBe(4);
    expect(alpha.reached).toBe(3);
    expect(alpha.reach).toBe(0.75);
    expect(alpha.outcomes).toEqual({
      reached: 3,
      'read-late': 0,
      bypassed: 0,
      'found-not-opened': 0,
      'searched-not-found': 0,
      'never-consulted': 1,
    });
    const beta = rowOf(card, BETA);
    expect(beta.expected).toBe(2);
    expect(beta.reach).toBe(0);
    expect(Object.keys(beta.outcomes)).toEqual([...OUTCOMES]);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#Counts and reach are per section]]
  it('lists the sections with the lowest reach first', () => {
    const card = build([
      ...many('b#B#Fine', 'reached', 2),
      record('a#A#Poor', 'bypassed'),
      record('a#A#Poor', 'reached'),
      record('a#A#Worse', 'bypassed'),
    ]);
    expect(card.sections.map((row) => row.section_id)).toEqual([
      'a#A#Worse',
      'a#A#Poor',
      'b#B#Fine',
    ]);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#The main miss is the most frequent outcome other than reached]]
  it('takes the most frequent outcome other than reached as the main miss', () => {
    const card = build([
      ...many(ALPHA, 'reached', 5),
      ...many(ALPHA, 'found-not-opened', 2),
      ...many(ALPHA, 'bypassed', 1),
    ]);
    expect(rowOf(card, ALPHA).main_miss).toBe('found-not-opened');
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#The main miss is the most frequent outcome other than reached]]
  it('breaks a tie in outcome order', () => {
    const card = build([
      ...many(ALPHA, 'never-consulted', 2),
      ...many(ALPHA, 'searched-not-found', 2),
      ...many(ALPHA, 'read-late', 2),
      ...many(BETA, 'never-consulted', 1),
      ...many(BETA, 'bypassed', 1),
    ]);
    expect(rowOf(card, ALPHA).main_miss).toBe('read-late');
    expect(rowOf(card, BETA).main_miss).toBe('bypassed');
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A section that was only reached has no main miss]]
  it('gives a section that was only reached no main miss and no fix', () => {
    const row = rowOf(build(many(ALPHA, 'reached', 2)), ALPHA);
    expect(row.main_miss).toBeNull();
    expect(row.suggested_fix).toBeNull();
    expect(row.reach).toBe(1);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#The suggested fix follows the main miss]]
  it('maps each miss to its fixed suggestion', () => {
    expect(SUGGESTED_FIXES).toEqual({
      'searched-not-found':
        'reword the section title and leading paragraph to match the words agents search with.',
      'found-not-opened':
        'improve the leading paragraph, which is the search preview.',
      'never-consulted':
        'link it from the code it describes with @lat comments, or make the prompt hook surface it.',
      bypassed: 'split the file; the section is hard to reach through lat.',
      'read-late':
        'a workflow problem, not a documentation problem; review agent instructions.',
    });
    for (const miss of OUTCOMES.filter((outcome) => outcome !== 'reached')) {
      const row = rowOf(build([record(ALPHA, miss)]), ALPHA);
      expect(row.main_miss).toBe(miss);
      expect(row.suggested_fix).toBe(
        SUGGESTED_FIXES[miss as keyof typeof SUGGESTED_FIXES],
      );
    }
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#Reach is a daily series by session start]]
  it('buckets the daily series by session start with null for an empty day', () => {
    const row = rowOf(
      build([
        record(ALPHA, 'reached', at(0)),
        record(ALPHA, 'bypassed', at(30)),
        record(ALPHA, 'reached', new Date(T0 + 2 * DAY).toISOString()),
        record(ALPHA, 'never-consulted', null),
      ]),
      ALPHA,
    );
    expect(row.daily).toEqual([
      { day: '2026-11-08', expected: 2, reached: 1, reach: 0.5 },
      { day: '2026-11-09', expected: 0, reached: 0, reach: null },
      { day: '2026-11-10', expected: 1, reached: 1, reach: 1 },
    ]);
    expect(row.expected).toBe(4);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A change marker sits where the content hash changed]]
  it('marks exactly the heads where the hash changed', () => {
    const card = build(
      [record(ALPHA, 'reached'), record(BETA, 'reached')],
      [
        headAt('h1', T0, [
          [ALPHA, 'a1'],
          [BETA, 'b1'],
        ]),
        headAt('h2', T0 + DAY, [
          [ALPHA, 'a2'],
          [BETA, 'b1'],
        ]),
        headAt('h3', T0 + 2 * DAY, [
          [ALPHA, 'a2'],
          [BETA, 'b1'],
        ]),
        headAt('h4', T0 + 3 * DAY, [
          [ALPHA, 'a3'],
          [BETA, 'b1'],
        ]),
      ],
    );
    expect(rowOf(card, ALPHA).change_markers).toEqual([
      { git_head: 'h2', day: '2026-11-09' },
      { git_head: 'h4', day: '2026-11-11' },
    ]);
    expect(rowOf(card, BETA).change_markers).toEqual([]);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#Markers are ordered and dated by the earliest event at each head]]
  it('orders heads by their earliest event, not by the order given', () => {
    const card = build(
      [record(ALPHA, 'reached')],
      [
        headAt('late', T0 + DAY, [[ALPHA, 'a3']]),
        headAt('first', T0, [[ALPHA, 'a1']]),
        headAt('middle', T0 + 12 * 60 * 60_000, [[ALPHA, 'a2']]),
      ],
    );
    expect(rowOf(card, ALPHA).change_markers).toEqual([
      { git_head: 'middle', day: '2026-11-08' },
      { git_head: 'late', day: '2026-11-09' },
    ]);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A head without a snapshot is reported]]
  it('skips a head without a snapshot and reports it', () => {
    const card = build(
      [record(ALPHA, 'reached')],
      [
        headAt('h1', T0, [[ALPHA, 'a1']]),
        headAt('gone', T0 + DAY, null, 'no such commit'),
        headAt('h3', T0 + 2 * DAY, [[ALPHA, 'a2']]),
      ],
    );
    expect(card.unavailable_heads).toEqual([
      { git_head: 'gone', reason: 'no such commit' },
    ]);
    expect(rowOf(card, ALPHA).change_markers).toEqual([
      { git_head: 'h3', day: '2026-11-10' },
    ]);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A renamed section is a new row and the old row ends]]
  it('detects a rename by file and body hash and ends the old row', () => {
    const renamed = 'lat.md/notes#Notes#Alpha Reworded';
    const card = build(
      [record(ALPHA, 'searched-not-found'), record(renamed, 'reached')],
      [
        headAt('h1', T0, [
          [ALPHA, 'same'],
          [BETA, 'b1'],
        ]),
        headAt('h2', T0 + DAY, [
          [renamed, 'same'],
          [BETA, 'b1'],
        ]),
      ],
    );
    const fresh = rowOf(card, renamed);
    expect(fresh.renamed_from).toBe(ALPHA);
    expect(fresh.ends_at_head).toBeNull();
    expect(fresh.change_markers).toEqual([]);
    const old = rowOf(card, ALPHA);
    expect(old.renamed_from).toBeNull();
    expect(old.ends_at_head).toBe('h1');
    expect(card.sections).toHaveLength(2);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A renamed section is a new row and the old row ends]]
  it('does not call a new id a rename when the body changed, the file differs or the old id remains', () => {
    const other = 'lat.md/other#Other#Alpha';
    const sameFileCopy = 'lat.md/notes#Notes#Copy';
    const edited = 'lat.md/notes#Notes#Edited';
    const card = build(
      [
        record(ALPHA, 'reached'),
        record(other, 'reached'),
        record(sameFileCopy, 'reached'),
        record(edited, 'reached'),
      ],
      [
        headAt('h1', T0, [[ALPHA, 'same']]),
        headAt('h2', T0 + DAY, [
          [ALPHA, 'same'],
          [other, 'same'],
          [sameFileCopy, 'same'],
          [edited, 'different'],
        ]),
      ],
    );
    for (const id of [other, sameFileCopy, edited])
      expect(rowOf(card, id).renamed_from).toBeNull();
    expect(rowOf(card, ALPHA).ends_at_head).toBeNull();
  });
});

describe('usage section scorecard through the aggregator', () => {
  let root: string;
  let heads: [string, string];
  let counter = 0;

  function git(...args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf-8' },
    ).trim();
  }

  function write(relPath: string, content: string): void {
    const path = join(root, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function usage(fields: Partial<UsageEvent>): UsageEvent {
    counter++;
    return {
      schema_version: USAGE_SCHEMA_VERSION,
      event_id: `u${counter}`,
      ts: at(0),
      duration_ms: 10,
      command: 'section',
      surface: 'cli',
      caller: 'agent',
      agent: 'claude',
      lat_version: '0.0.0',
      session_id: 'A',
      parent_session_id: null,
      repo_root: root,
      git_head: heads[0],
      worktree: root,
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

  function sessionEvent(
    kind: SessionEvent['kind'],
    sessionId: string,
    minutes: number,
    extra: Record<string, unknown> = {},
  ): SessionEvent {
    counter++;
    return {
      kind,
      event_id: `s${counter}`,
      session_id: sessionId,
      ts: at(minutes),
      source: { path: `/fake/${sessionId}.jsonl`, offset: counter },
      ...extra,
    } as SessionEvent;
  }

  function session(sessionId: string, start: number): SessionEvent[] {
    return [
      sessionEvent('session_start', sessionId, start),
      sessionEvent('token_usage', sessionId, start + 0.1, {
        usage: {
          input: null,
          output: null,
          cache_read: null,
          cache_write: null,
          reasoning: null,
        },
      }),
      sessionEvent('tool_call', sessionId, start + 10, {
        tool: { name: 'tool', action: 'edit', path: 'src/a.ts', bytes: null },
      }),
      sessionEvent('session_end', sessionId, start + 60),
    ];
  }

  function fakeSource(
    agent: SessionAgent,
    events: SessionEvent[],
  ): SessionSource {
    return {
      agent,
      discover: async () => (events.length ? [`/fake/${agent}.jsonl`] : []),
      read: async () => ({
        events,
        checkpoint: { offset: events.length },
        reason: null,
      }),
    };
  }

  function cache(gitHead: string, hash: string): void {
    write(
      `.lat/usage/graph-snapshots/${gitHead}.json`,
      JSON.stringify({
        ...snapshot(gitHead, [[ALPHA, hash]]),
        code_ref_edges: [{ file: 'src/a.ts', line: 1, section: ALPHA }],
      }),
    );
  }

  async function summary() {
    const bd: BdSnapshot = { issues: [], discoveredFrom: [], reopens: [] };
    const aggregator = await createAggregator({
      root,
      sources: [
        fakeSource('claude', [...session('A', 0), ...session('B', 24 * 60)]),
        fakeSource('codex', []),
      ],
      bd: { refresh: async () => bd },
      contributions: [sectionScorecardContribution],
      now: () => Date.parse('2026-11-10T00:00:00Z'),
    });
    await aggregator.refresh();
    return aggregator.summary();
  }

  beforeEach(() => {
    forgetSnapshots();
    forgetMissedKnowledge();
    counter = 0;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-scorecard-')));
    git('init', '-q');
    write('src/a.ts', 'export const a = 1;\n');
    write('lat.md/notes.md', '# Notes\n');
    git('add', '-A');
    git('commit', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    write('lat.md/notes.md', '# Notes\n\nmore\n');
    git('commit', '-a', '-m', 'second');
    heads = [first, git('rev-parse', 'HEAD')];
    cache(heads[0], 'old');
    cache(heads[1], 'new');
    writeUsageEvent(
      root,
      usage({
        ts: at(-1),
        command: 'check',
        caller: 'human',
        agent: null,
        session_id: null,
      }),
    );
    writeUsageEvent(
      root,
      usage({ ts: at(5), section_id: ALPHA, git_head: heads[0] }),
    );
    writeUsageEvent(
      root,
      usage({
        ts: at(24 * 60 + 5),
        session_id: 'B',
        command: 'check',
        git_head: heads[1],
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#The scorecard uses the missed-knowledge records through the aggregator]]
  it('rolls up the missed-knowledge outcomes and marks the head of the change', async () => {
    const result = (await summary()).extensions[
      sectionScorecardContribution.key
    ] as SectionScorecard;
    expect(sectionScorecardContribution.key).toBe('section_scorecard');
    const row = rowOf(result, ALPHA);
    expect(row.expected).toBe(2);
    expect(row.outcomes.reached).toBe(1);
    expect(row.outcomes['never-consulted']).toBe(1);
    expect(row.main_miss).toBe('never-consulted');
    expect(row.reach).toBe(0.5);
    expect(row.change_markers).toEqual([
      { git_head: heads[1], day: '2026-11-09' },
    ]);
    expect(row.daily.find((point) => point.day === '2026-11-08')).toEqual({
      day: '2026-11-08',
      expected: 1,
      reached: 1,
      reach: 1,
    });
    expect(result.unavailable_heads).toEqual([]);
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A failing missed-knowledge analysis is an error, not zeros]]
  it('reports an error when the missed-knowledge compute throws', async () => {
    vi.spyOn(missedKnowledgeContribution, 'compute').mockImplementation(() => {
      throw new Error('analysis broke');
    });
    const extensions = (await summary()).extensions;
    expect(extensions[sectionScorecardContribution.key]).toEqual({
      error: 'analysis broke',
    });
  });

  // @lat: [[usage-section-scorecard#Usage Section Scorecard#A failing missed-knowledge analysis is an error, not zeros]]
  it('reports an error when the missed-knowledge prepare throws', async () => {
    vi.spyOn(
      missedKnowledgeContribution as Required<Contribution>,
      'prepare',
    ).mockImplementation(async () => {
      throw new Error('prepare broke');
    });
    const extensions = (await summary()).extensions;
    expect(extensions[sectionScorecardContribution.key]).toEqual({
      error: 'prepare broke',
    });
  });
});
