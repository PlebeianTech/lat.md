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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAggregator,
  type UsageSummary,
} from '../src/fork/usage/aggregate.js';
import { forgetSnapshots } from '../src/fork/usage/graph-snapshot.js';
import {
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import {
  BYTES_PER_TOKEN,
  SAVINGS_METHOD_VERSION,
  savingsContribution,
  type SavingsEstimate,
} from '../src/fork/usage/savings.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';

let root: string;
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

const NOTES = `# Notes

Intro text.

## Alpha

Alpha text.
`;
const NOTES_BYTES = Buffer.byteLength(NOTES);
const ALPHA = 'lat.md/notes#Notes#Alpha';

function usage(fields: Partial<UsageEvent>): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${counter}`,
    ts: '2026-11-08T10:00:00.000Z',
    duration_ms: 10,
    command: 'section',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: root,
    git_head: head,
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

const read = (bytesOut: number | null, fields: Partial<UsageEvent> = {}) =>
  usage({ section_id: ALPHA, bytes_out: bytesOut, ...fields });

const hook = (injected: number | null, fields: Partial<UsageEvent> = {}) =>
  usage({
    command: 'hook',
    caller: 'hook-injected',
    injected_bytes: injected,
    ...fields,
  });

async function summaryFor(events: UsageEvent[]): Promise<UsageSummary> {
  for (const event of events) writeUsageEvent(root, event);
  const aggregator = await createAggregator({
    root,
    sources: [],
    bd: { refresh: async () => null },
    contributions: [savingsContribution],
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  await aggregator.refresh();
  return aggregator.summary();
}

const estimateOf = (summary: UsageSummary) =>
  summary.extensions[savingsContribution.key] as SavingsEstimate;

const { low, point: mid, high } = BYTES_PER_TOKEN;

let head: string;

beforeEach(() => {
  forgetSnapshots();
  counter = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lat-usage-savings-')));
  git('init', '-q');
  write('lat.md/notes.md', NOTES);
  git('add', '-A');
  git('commit', '-m', 'first');
  head = git('rev-parse', 'HEAD');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('usage savings', () => {
  // @lat: [[usage-savings#Usage Savings#A section read saves its document's bytes minus bytes_out]]
  it('saves the snapshot document bytes minus bytes_out', async () => {
    const estimate = estimateOf(await summaryFor([read(20)]));
    expect(estimate.reads).toBe(1);
    expect(estimate.saved_bytes).toEqual({
      total: NOTES_BYTES - 20,
      known: 1,
      unknown: 0,
    });
    expect(estimate.net_tokens_saved!.point).toBe(
      Math.round((NOTES_BYTES - 20) / mid),
    );
  });

  // @lat: [[usage-savings#Usage Savings#A hook event adds injected cost and no saving]]
  it('counts a hook event with a section_id only as cost', async () => {
    const estimate = estimateOf(
      await summaryFor([hook(40, { section_id: ALPHA })]),
    );
    expect(estimate.reads).toBe(0);
    expect(estimate.saved_bytes).toEqual({ total: 0, known: 0, unknown: 0 });
    expect(estimate.injected_bytes).toEqual({
      total: 40,
      known: 1,
      unknown: 0,
    });
    expect(estimate.net_tokens_saved!.point).toBe(Math.round(-40 / mid));
  });

  // @lat: [[usage-savings#Usage Savings#Injected bytes are subtracted per session]]
  it('subtracts the injections of each session from that session only', async () => {
    const summary = await summaryFor([
      read(20, { session_id: 'A' }),
      hook(30, { session_id: 'A' }),
      read(10, { session_id: 'B' }),
    ]);
    const rows = Object.fromEntries(
      summary.sessions.map((row) => [row.key, row.signals.net_tokens_saved]),
    );
    expect(rows.A).toBe(Math.round((NOTES_BYTES - 20 - 30) / mid));
    expect(rows.B).toBe(Math.round((NOTES_BYTES - 10) / mid));
    expect(estimateOf(summary).net_tokens_saved!.point).toBe(
      Math.round((2 * NOTES_BYTES - 20 - 30 - 10) / mid),
    );
  });

  // @lat: [[usage-savings#Usage Savings#The range brackets the point estimate]]
  it('brackets the point estimate, also for a negative net', async () => {
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    const net = estimateOf(
      await summaryFor([read(20), hook(30)]),
    ).net_tokens_saved!;
    expect(net.low).toBe(Math.round((NOTES_BYTES - 20) / high - 30 / low));
    expect(net.high).toBe(Math.round((NOTES_BYTES - 20) / low - 30 / high));
    expect(net.low).toBeLessThanOrEqual(net.point);
    expect(net.point).toBeLessThanOrEqual(net.high);
  });

  // @lat: [[usage-savings#Usage Savings#The range brackets the point estimate]]
  it('keeps the bracket when the injections outweigh the savings', async () => {
    const net = estimateOf(
      await summaryFor([read(20), hook(5000)]),
    ).net_tokens_saved!;
    expect(net.point).toBeLessThan(0);
    expect(net.low).toBeLessThanOrEqual(net.point);
    expect(net.point).toBeLessThanOrEqual(net.high);
  });

  // @lat: [[usage-savings#Usage Savings#Every result carries method_version and its inputs]]
  it('carries method_version, the label and its inputs', async () => {
    const estimate = estimateOf(await summaryFor([read(20), hook(30)]));
    expect(estimate.method_version).toBe(SAVINGS_METHOD_VERSION);
    expect(estimate.label).toBe('correlation, not cause');
    expect(estimate.bytes_per_token).toEqual(BYTES_PER_TOKEN);
    expect(estimate.reads).toBe(1);
    expect(estimate.saved_bytes.known).toBe(1);
    expect(estimate.injected_bytes.total).toBe(30);
    expect(estimate.unknown_reads).toEqual([]);
    expect(estimate.reason).toBeNull();
  });

  // @lat: [[usage-savings#Usage Savings#An unknown input gives null with a reason, never zero]]
  it('gives null with a reason when no snapshot exists for the head', async () => {
    const summary = await summaryFor([read(20, { git_head: 'f'.repeat(40) })]);
    const estimate = estimateOf(summary);
    expect(estimate.net_tokens_saved).toBeNull();
    expect(estimate.reason).toMatch(/snapshot/);
    expect(estimate.saved_bytes).toEqual({
      total: null,
      known: 0,
      unknown: 1,
    });
    expect(summary.signals.net_tokens_saved).toBeNull();
    expect(summary.signals.net_tokens_saved_reason).toMatch(/snapshot/);
  });

  // @lat: [[usage-savings#Usage Savings#An unknown input gives null with a reason, never zero]]
  it('names each kind of unknown read and covers the known ones', async () => {
    const estimate = estimateOf(
      await summaryFor([
        read(20),
        read(null),
        read(20, { git_head: null }),
        read(20, { section_id: 'lat.md/notes#Notes#Gone' }),
      ]),
    );
    expect(estimate.saved_bytes).toEqual({
      total: NOTES_BYTES - 20,
      known: 1,
      unknown: 3,
    });
    expect(estimate.unknown_reads.map((r) => r.reason).sort()).toEqual([
      'bytes_out not captured',
      'git_head not captured',
      'section lat.md/notes#Notes#Gone not in the snapshot',
    ]);
    expect(estimate.net_tokens_saved).not.toBeNull();
  });

  // @lat: [[usage-savings#Usage Savings#An unknown input gives null with a reason, never zero]]
  it('gives null when the saving is unknown but a hook cost is known', async () => {
    const estimate = estimateOf(await summaryFor([read(null), hook(30)]));
    expect(estimate.net_tokens_saved).toBeNull();
    expect(estimate.reason).toMatch(/bytes_out/);
  });

  // @lat: [[usage-savings#Usage Savings#An unknown input gives null with a reason, never zero]]
  it('gives null when the cost is unknown but a saving is known', async () => {
    const estimate = estimateOf(await summaryFor([read(20), hook(null)]));
    expect(estimate.net_tokens_saved).toBeNull();
    expect(estimate.reason).toMatch(/injected_bytes/);
  });

  // @lat: [[usage-savings#Usage Savings#An unknown input gives null with a reason, never zero]]
  it('treats a null injected_bytes as unknown, not zero', async () => {
    const estimate = estimateOf(await summaryFor([hook(null)]));
    expect(estimate.injected_bytes).toEqual({
      total: null,
      known: 0,
      unknown: 1,
    });
    expect(estimate.net_tokens_saved).toBeNull();
    expect(estimate.reason).toMatch(/injected_bytes/);
  });

  // @lat: [[usage-savings#Usage Savings#The range brackets the point estimate]]
  it('keeps the bracket when the saved total is negative', async () => {
    const net = estimateOf(
      await summaryFor([read(NOTES_BYTES + 100)]),
    ).net_tokens_saved!;
    expect(net.point).toBeLessThan(0);
    expect(net.low).toBeLessThan(net.point);
    expect(net.point).toBeLessThan(net.high);
  });

  // @lat: [[usage-savings#Usage Savings#A saving below zero is kept]]
  it('keeps a negative saving', async () => {
    const estimate = estimateOf(await summaryFor([read(NOTES_BYTES + 100)]));
    expect(estimate.saved_bytes.total).toBe(-100);
    expect(estimate.net_tokens_saved!.point).toBeLessThan(0);
  });

  // @lat: [[usage-savings#Usage Savings#Rows carry the estimate]]
  it('fills net tokens saved on agent, session and issue rows', async () => {
    const summary = await summaryFor([read(20), hook(30)]);
    const expected = Math.round((NOTES_BYTES - 20 - 30) / mid);
    expect(summary.signals.net_tokens_saved).toBe(expected);
    expect(summary.sessions[0].signals.net_tokens_saved).toBe(expected);
    expect(summary.sessions[0].signals.injected_bytes.total).toBe(30);
    const claude = summary.agents.find((row) => row.key === 'claude')!;
    expect(claude.signals.net_tokens_saved).toBe(expected);
    expect(summary.unattributed.signals.net_tokens_saved).toBe(expected);
  });

  // @lat: [[usage-savings#Usage Savings#Rows carry the estimate]]
  it('gives rows a non-null range on the first summary', async () => {
    const summary = await summaryFor([read(20)]);
    expect(summary.sessions[0].signals.net_tokens_saved).toBe(
      Math.round((NOTES_BYTES - 20) / mid),
    );
    expect(estimateOf(summary).net_tokens_saved).not.toBeNull();
  });

  // @lat: [[usage-savings#Usage Savings#Rows carry the estimate]]
  it('shows null with a reason on a row whose inputs are all unknown', async () => {
    const summary = await summaryFor([read(null)]);
    const row = summary.sessions[0];
    expect(row.signals.net_tokens_saved).toBeNull();
    expect(row.signals.net_tokens_saved_reason).toMatch(/bytes_out/);
  });
});
