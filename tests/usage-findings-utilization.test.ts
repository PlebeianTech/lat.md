import { describe, expect, it } from 'vitest';
import type { RawRecord } from '../src/fork/usage/event-index.js';
import {
  computeFindings,
  findingDetectors,
  type FindingsInput,
} from '../src/fork/usage/findings.js';
import {
  createUtilizationDetector,
  utilizationDetector,
} from '../src/fork/usage/findings-utilization.js';
import type { UsageSummary } from '../src/fork/usage/aggregate-types.js';

const DAYS = ['2026-11-08', '2026-11-09'];
const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function edit(id: string, sessionId: string, path: string, minutes = 1) {
  return {
    id,
    ts: at(minutes),
    agent: 'claude',
    session_id: sessionId,
    issue_ids: [],
    attribution: 'unattributed',
    type: 'session',
    event: {
      kind: 'tool_call',
      event_id: id,
      session_id: sessionId,
      ts: at(minutes),
      source: { path: '/fake', offset: 0 },
      tool: { name: 'Edit', action: 'edit', path, bytes: null },
    },
  } as unknown as RawRecord;
}

function search(id: string, sessionId: string, query: string, minutes = 1) {
  return {
    id,
    ts: at(minutes),
    agent: 'claude',
    session_id: sessionId,
    issue_ids: [],
    attribution: 'unattributed',
    type: 'usage',
    event: { command: 'search', query, result_count: 3, session_id: sessionId },
  } as unknown as RawRecord;
}

const missed = (sessionId: string, sectionId: string, queries: string[]) => ({
  session_id: sessionId,
  section_id: sectionId,
  outcome: 'searched-not-found',
  session_start: at(0),
  git_head: 'abc',
  queries_before_first_edit: queries,
});

function input(records: RawRecord[], missedKnowledge: unknown): FindingsInput {
  return {
    summary: {
      days: DAYS,
      sections: [],
      extensions: { missed_knowledge: missedKnowledge },
    } as unknown as UsageSummary,
    records,
  };
}

const analysis = (
  undocumented: { path: string; sessions: number; edits: number }[],
  records: unknown[] = [],
) => ({ undocumented_files: undocumented, records });

describe('utilization findings', () => {
  it('is registered with the findings engine', () => {
    expect(findingDetectors).toContain(utilizationDetector);
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A file edited in three sessions without coverage is reported]]
  it('reports a file edited in three sessions and not one edited in two', () => {
    const result = computeFindings(
      input(
        [
          edit('e1', 'A', 'src/hot.ts', 1),
          edit('e2', 'B', 'src/hot.ts', 2),
          edit('e3', 'C', 'src/hot.ts', 3),
          edit('e4', 'A', 'src/other.ts'),
          edit('e5', 'B', 'src/other.ts'),
        ],
        analysis([
          { path: 'src/hot.ts', sessions: 3, edits: 3 },
          { path: 'src/other.ts', sessions: 2, edits: 2 },
        ]),
      ),
    );
    expect(result.errors).toEqual([]);
    const found = result.findings.filter(
      (finding) => finding.kind === 'uncovered-hot-file',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: 'uncovered-hot-file:src/hot.ts',
      subject: 'src/hot.ts',
      count: 3,
      sessions: 3,
      first_seen: at(1),
      last_seen: at(3),
      evidence: ['e3', 'e2', 'e1'],
      suggestion: null,
    });
    expect(found[0].daily).toEqual([
      { day: '2026-11-08', count: 3 },
      { day: '2026-11-09', count: 0 },
    ]);
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A search that missed a needed section is reported]]
  it('reports a search that missed the section a session then needed', () => {
    const result = computeFindings(
      input(
        [
          search('s1', 'A', 'how do locks work'),
          search('s2', 'B', 'how do locks work'),
          search('s3', 'C', 'how do locks work'),
          search('s4', 'A', 'unrelated'),
        ],
        analysis(
          [],
          [
            missed('A', 'locks#Locks#Order', ['how do locks work']),
            missed('B', 'locks#Locks#Order', ['how do locks work']),
            missed('A', 'locks#Locks#Release', ['how do locks work']),
            {
              ...missed('C', 'locks#Locks#Order', ['how do locks work']),
              outcome: 'found-not-opened',
              queries_before_first_edit: null,
            },
          ],
        ),
      ),
    );
    expect(result.errors).toEqual([]);
    const found = result.findings.filter(
      (finding) => finding.kind === 'search-miss',
    );
    expect(found.map((finding) => finding.id).sort()).toEqual([
      'search-miss:how do locks work|locks#Locks#Order',
      'search-miss:how do locks work|locks#Locks#Release',
    ]);
    const order = found.find(
      (finding) => finding.expected_section_id === 'locks#Locks#Order',
    )!;
    expect(order).toMatchObject({
      subject: 'how do locks work',
      count: 2,
      sessions: 2,
      evidence: ['s2', 's1'],
    });
    const release = found.find(
      (finding) => finding.expected_section_id === 'locks#Locks#Release',
    )!;
    expect(release).toMatchObject({ count: 1, sessions: 1, evidence: ['s1'] });
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A file edited in three sessions without coverage is reported]]
  it('matches edit paths by the real git prefix', async () => {
    const records = [
      edit('e1', 'A', './src/x.ts', 1),
      edit('e2', 'B', 'pkg/src/x.ts', 2),
      edit('e3', 'C', 'src/x.ts', 3),
    ];
    const run = async (prefix: string) => {
      const detector = createUtilizationDetector(async () => prefix);
      await detector.prepare!({ root: '/r' });
      return detector.detect(
        input(records, analysis([{ path: 'src/x.ts', sessions: 3, edits: 3 }])),
      )[0];
    };
    expect(await run('pkg/')).toMatchObject({
      count: 1,
      sessions: 1,
      evidence: ['e2'],
    });
    expect(await run('')).toMatchObject({
      count: 2,
      sessions: 2,
      evidence: ['e3', 'e1'],
    });
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A file edited in three sessions without coverage is reported]]
  it('never matches a root-level file against another directory', async () => {
    const detector = createUtilizationDetector(async () => '');
    await detector.prepare!({ root: '/r' });
    const [found] = detector.detect(
      input(
        [edit('e1', 'A', 'other/index.ts'), edit('e2', 'B', 'index.ts')],
        analysis([{ path: 'index.ts', sessions: 3, edits: 3 }]),
      ),
    );
    expect(found).toMatchObject({ count: 1, evidence: ['e2'] });
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A file edited in three sessions without coverage is reported]]
  it('treats a git failure as an empty prefix', async () => {
    const detector = createUtilizationDetector(async () => {
      throw new Error('not a repository');
    });
    await expect(detector.prepare!({ root: '/r' })).resolves.toBeUndefined();
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A search that missed a needed section is reported]]
  it('leaves out searches made after the first edit', () => {
    const result = computeFindings(
      input(
        [
          search('before', 'A', 'locks', 1),
          edit('e1', 'A', 'src/a.ts', 5),
          search('after', 'A', 'locks', 9),
        ],
        analysis([], [missed('A', 'locks#Locks#Order', ['locks'])]),
      ),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      count: 1,
      sessions: 1,
      evidence: ['before'],
    });
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#Utilization findings rank and group like other findings]]
  it('ranks both kinds with the other detectors', () => {
    const result = computeFindings(
      input(
        [
          edit('e1', 'A', 'src/hot.ts'),
          edit('e2', 'B', 'src/hot.ts'),
          edit('e3', 'C', 'src/hot.ts'),
          edit('e4', 'D', 'src/hot.ts'),
          search('s1', 'A', 'q'),
        ],
        analysis(
          [{ path: 'src/hot.ts', sessions: 4, edits: 4 }],
          [missed('A', 'd#D#S', ['q'])],
        ),
      ),
    );
    expect(result.findings.map((finding) => finding.id)).toEqual([
      'uncovered-hot-file:src/hot.ts',
      'search-miss:q|d#D#S',
    ]);
    for (const finding of result.findings)
      expect(finding.daily.map((point) => point.day)).toEqual(DAYS);
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A failed analysis is an error, an absent one is empty]]
  it('returns nothing when the analysis is absent', () => {
    const result = computeFindings(input([edit('e1', 'A', 'x.ts')], undefined));
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  // @lat: [[usage-findings-utilization#Usage Findings Utilization#A failed analysis is an error, an absent one is empty]]
  it('reports a failed analysis as a detector error', () => {
    const result = computeFindings(input([], { error: 'boom' }));
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([
      {
        detector: 'utilization',
        message: 'missed-knowledge analysis failed: boom',
      },
    ]);
  });
});
