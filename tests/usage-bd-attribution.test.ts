import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '../src/fork/usage/schema.js';
import {
  attributeActivity,
  createBdWatcher,
  type Activity,
  type AttributionSessionEvent,
  type BdSnapshot,
} from '../src/fork/usage/bd-attribution.js';
import {
  createBdRunner,
  findReopens,
  loadIssueGraph,
  type BdIssue,
  type BdRunner,
  type JournalRecord,
} from '../src/fork/usage/bd-client.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let counter = 0;
function bdCommand(
  session: string,
  minutes: number,
  verb: 'claim' | 'close',
  issueId: string,
  parent?: string,
): SessionEvent {
  return {
    kind: 'bd_command',
    verb,
    issue_id: issueId,
    event_id: `bd-${counter++}`,
    session_id: session,
    ts: at(minutes),
    ...(parent ? { parent_session_id: parent } : {}),
    source: { path: '/s.jsonl', offset: counter },
  };
}

function activity(session: string, minutes: number, parent?: string): Activity {
  return {
    event_id: `a-${session}-${minutes}`,
    session_id: session,
    ts: at(minutes),
    ...(parent ? { parent_session_id: parent } : {}),
  };
}

function issue(id: string, extra: Partial<BdIssue> = {}): BdIssue {
  return {
    id,
    title: `title ${id}`,
    status: 'open',
    issue_type: 'task',
    created_at: at(-1000),
    ...extra,
  };
}

function snapshot(issues: BdIssue[]): BdSnapshot {
  return { issues, discoveredFrom: [], reopens: [] };
}

function attribute(
  events: Activity[],
  commands: AttributionSessionEvent[],
  issues: BdIssue[],
) {
  return attributeActivity(events, commands, snapshot(issues));
}

/**
 * Trimmed output of `bd events export` from a throwaway database on
 * 2026-11-08: create, claim, close, then `bd reopen --reason again`. Titles
 * and owner fields are dropped; ids, ops, timestamps and statuses are as bd
 * wrote them.
 */
const CAPTURED_REOPEN_JOURNAL = `
{"seq":1,"ts":"2026-11-08T23:16:58Z","op":"create","issue_id":"tmp-dmw","actor":"tester","issue":{"id":"tmp-dmw","status":"open","issue_type":"bug","created_at":"2026-11-08T23:16:58Z"}}
{"seq":2,"ts":"2026-11-08T23:16:59Z","op":"update","issue_id":"tmp-dmw","actor":"tester","issue":{"id":"tmp-dmw","status":"in_progress","assignee":"tester","started_at":"2026-11-08T23:16:59Z"}}
{"seq":3,"ts":"2026-11-08T23:16:59Z","op":"close","issue_id":"tmp-dmw","actor":"tester","issue":{"id":"tmp-dmw","status":"closed","assignee":"tester","started_at":"2026-11-08T23:16:59Z","closed_at":"2026-11-08T23:16:59Z","close_reason":"done"}}
{"seq":4,"ts":"2026-11-08T23:17:01Z","op":"comment","issue_id":"tmp-dmw","actor":"tester","issue":{"id":"tmp-dmw","status":"open","assignee":"tester","started_at":"2026-11-08T23:16:59Z"},"comment":{"author":"tester","text":"again","source":"audit"}}
{"seq":5,"ts":"2026-11-08T23:17:01Z","op":"update","issue_id":"tmp-dmw","actor":"tester","issue":{"id":"tmp-dmw","status":"open","assignee":"tester","started_at":"2026-11-08T23:16:59Z"}}
`;

describe('usage bd attribution', () => {
  // @lat: [[usage-bd-attribution#Usage bd Attribution#Claim to close attributes a session's events]]
  it('attributes events between claim and close, ends included', () => {
    const commands = [
      bdCommand('s1', 10, 'claim', 'x'),
      bdCommand('s1', 20, 'close', 'x'),
    ];
    const events = [5, 10, 15, 20, 25].map((m) => activity('s1', m));
    const { attributions } = attribute(events, commands, [issue('x')]);
    const ids = events.map((e) => attributions.get(e.event_id));
    expect(ids.map((a) => a?.issue_ids)).toEqual([[], ['x'], ['x'], ['x'], []]);
    expect(ids[2]).toEqual({
      issue_ids: ['x'],
      method: 'claim',
      shared: false,
    });
    expect(ids[0]?.method).toBe('unattributed');
    expect(ids[4]?.method).toBe('unattributed');
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Two open issues share their events]]
  it('attributes to both open issues and marks the event shared', () => {
    const commands = [
      bdCommand('s1', 0, 'claim', 'x'),
      bdCommand('s1', 5, 'claim', 'y'),
      bdCommand('s1', 15, 'close', 'x'),
    ];
    const both = activity('s1', 10);
    const onlyY = activity('s1', 20);
    const { attributions } = attribute([both, onlyY], commands, [
      issue('x'),
      issue('y'),
    ]);
    expect(attributions.get(both.event_id)).toEqual({
      issue_ids: ['x', 'y'],
      method: 'claim',
      shared: true,
    });
    expect(attributions.get(onlyY.event_id)?.issue_ids).toEqual(['y']);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#A session spanning two issues in sequence]]
  it('follows a session from one issue to the next', () => {
    const commands = [
      bdCommand('s1', 0, 'claim', 'x'),
      bdCommand('s1', 10, 'close', 'x'),
      bdCommand('s1', 12, 'claim', 'y'),
      bdCommand('s1', 30, 'close', 'y'),
    ];
    const first = activity('s1', 5);
    const gap = activity('s1', 11);
    const second = activity('s1', 20);
    const { attributions } = attribute([first, gap, second], commands, [
      issue('x'),
      issue('y'),
    ]);
    expect(attributions.get(first.event_id)?.issue_ids).toEqual(['x']);
    expect(attributions.get(gap.event_id)?.method).toBe('unattributed');
    expect(attributions.get(second.event_id)?.issue_ids).toEqual(['y']);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#An issue spanning several sessions]]
  it('bounds each session by its own claim and close', () => {
    const commands = [
      bdCommand('s1', 0, 'claim', 'x'),
      bdCommand('s1', 10, 'close', 'x'),
      bdCommand('s2', 20, 'claim', 'x'),
      bdCommand('s2', 30, 'close', 'x'),
    ];
    const inS1 = activity('s1', 5);
    const inS2 = activity('s2', 25);
    const s2During = activity('s2', 5);
    const stranger = activity('s3', 5);
    const { attributions } = attribute(
      [inS1, inS2, s2During, stranger],
      commands,
      [issue('x')],
    );
    expect(attributions.get(inS1.event_id)?.issue_ids).toEqual(['x']);
    expect(attributions.get(inS2.event_id)?.issue_ids).toEqual(['x']);
    expect(attributions.get(s2During.event_id)?.method).toBe('unattributed');
    expect(attributions.get(stranger.event_id)?.method).toBe('unattributed');
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Subagent sessions use the parent claim]]
  it('attributes a subagent through its parent, then grandparent', () => {
    const commands = [bdCommand('top', 0, 'claim', 'x')];
    const child = activity('sub', 5, 'top');
    const grandchild = activity('subsub', 6, 'sub');
    const { attributions } = attribute([child, grandchild], commands, [
      issue('x'),
    ]);
    expect(attributions.get(child.event_id)).toEqual({
      issue_ids: ['x'],
      method: 'claim',
      shared: false,
    });
    expect(attributions.get(grandchild.event_id)?.issue_ids).toEqual(['x']);
  });

  it('prefers a subagent claim of its own over the parent', () => {
    const commands = [
      bdCommand('top', 0, 'claim', 'x'),
      bdCommand('sub', 1, 'claim', 'y', 'top'),
    ];
    const child = activity('sub', 5, 'top');
    const { attributions } = attribute([child], commands, [
      issue('x'),
      issue('y'),
    ]);
    expect(attributions.get(child.event_id)?.issue_ids).toEqual(['y']);
  });

  it('learns a parent link from a non-bd event of the subagent', () => {
    const commands: AttributionSessionEvent[] = [
      bdCommand('top', 0, 'claim', 'x'),
      {
        kind: 'session_start',
        session_id: 'sub',
        ts: at(1),
        parent_session_id: 'top',
      },
    ];
    // The lat command itself carries no parent link.
    const latCommand = activity('sub', 5);
    const { attributions } = attribute([latCommand], commands, [issue('x')]);
    expect(attributions.get(latCommand.event_id)?.issue_ids).toEqual(['x']);
    expect(
      attribute([latCommand], [commands[0]], [issue('x')]).attributions.get(
        latCommand.event_id,
      )?.method,
    ).toBe('unattributed');
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Timestamp fallback]]
  it('falls back to the assigned started_at and closed_at window', () => {
    const issues = [
      issue('done', {
        status: 'closed',
        assignee: 'dave',
        started_at: at(0),
        closed_at: at(10),
      }),
      issue('live', {
        status: 'in_progress',
        assignee: 'dave',
        started_at: at(100),
      }),
      issue('unassigned', {
        status: 'closed',
        started_at: at(-200),
        closed_at: at(-100),
      }),
    ];
    const inDone = activity('s9', 5);
    const inLive = activity('s9', 500);
    const inUnassigned = activity('s9', -150);
    const { attributions } = attribute(
      [inDone, inLive, inUnassigned],
      [],
      issues,
    );
    expect(attributions.get(inDone.event_id)).toEqual({
      issue_ids: ['done'],
      method: 'timestamp',
      shared: false,
    });
    expect(attributions.get(inLive.event_id)?.issue_ids).toEqual(['live']);
    expect(attributions.get(inUnassigned.event_id)?.method).toBe(
      'unattributed',
    );
  });

  it('excludes events just outside the window, includes both edges', () => {
    const issues = [
      issue('x', {
        status: 'closed',
        assignee: 'd',
        started_at: at(10),
        closed_at: at(20),
      }),
    ];
    const ids = [9, 10, 20, 21].map((m) => activity('s9', m));
    const { attributions } = attribute(ids, [], issues);
    expect(ids.map((e) => attributions.get(e.event_id)?.method)).toEqual([
      'unattributed',
      'timestamp',
      'timestamp',
      'unattributed',
    ]);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Closes in any session end a claim]]
  it('ends a claim when another session closes the issue', () => {
    const commands = [
      bdCommand('parent', 0, 'claim', 'x'),
      bdCommand('sub', 10, 'close', 'x', 'parent'),
    ];
    const during = activity('parent', 5);
    const after = activity('parent', 15);
    const subAtClose = activity('sub', 10, 'parent');
    const { attributions } = attribute([during, after, subAtClose], commands, [
      issue('x'),
    ]);
    expect(attributions.get(during.event_id)?.issue_ids).toEqual(['x']);
    expect(attributions.get(after.event_id)?.method).toBe('unattributed');
    expect(attributions.get(subAtClose.event_id)?.issue_ids).toEqual(['x']);
  });

  it('caps a claim nobody closed at the snapshot closed_at', () => {
    const commands = [bdCommand('s1', 0, 'claim', 'x')];
    const inside = activity('s1', 5);
    const after = activity('s1', 25);
    const { attributions } = attribute([inside, after], commands, [
      issue('x', { status: 'closed', closed_at: at(10) }),
    ]);
    expect(attributions.get(inside.event_id)?.issue_ids).toEqual(['x']);
    expect(attributions.get(after.event_id)?.method).toBe('unattributed');
  });

  it('treats a duplicate claim as one interval, closed by one close', () => {
    const commands = [
      bdCommand('s1', 0, 'claim', 'x'),
      bdCommand('s1', 5, 'claim', 'x'),
      bdCommand('s1', 10, 'close', 'x'),
    ];
    const inside = activity('s1', 7);
    const after = activity('s1', 12);
    const { attributions } = attribute([inside, after], commands, [issue('x')]);
    expect(attributions.get(inside.event_id)?.issue_ids).toEqual(['x']);
    expect(attributions.get(after.event_id)?.method).toBe('unattributed');
  });

  it('prefers a claim over the timestamp window', () => {
    const issues = [
      issue('timed', { assignee: 'd', started_at: at(0), closed_at: at(60) }),
      issue('claimed'),
    ];
    const commands = [bdCommand('s1', 0, 'claim', 'claimed')];
    const event = activity('s1', 5);
    const { attributions } = attribute([event], commands, issues);
    expect(attributions.get(event.event_id)?.issue_ids).toEqual(['claimed']);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Rollup through two levels of parent-child]]
  it('rolls activity up an epic, sub-epic and task', () => {
    const issues = [
      issue('epic', { issue_type: 'epic' }),
      issue('sub', { issue_type: 'epic', parent: 'epic' }),
      issue('task', { parent: 'sub' }),
      issue('bug', { issue_type: 'bug', parent: 'epic' }),
    ];
    const commands = [
      bdCommand('s1', 0, 'claim', 'task'),
      bdCommand('s2', 0, 'claim', 'bug'),
    ];
    const both = activity('s1', 5);
    const bugEvent = activity('s2', 5);
    const { rollup } = attribute([both, bugEvent], commands, issues);
    expect(rollup.get('task')).toEqual({
      own: [both.event_id],
      rolled_up: [both.event_id],
    });
    expect(rollup.get('sub')?.rolled_up).toEqual([both.event_id]);
    expect(rollup.get('epic')?.own).toEqual([]);
    expect(rollup.get('epic')?.rolled_up.sort()).toEqual(
      [both.event_id, bugEvent.event_id].sort(),
    );
    expect(rollup.has('bug')).toBe(true);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Nested claims credit the most specific issue]]
  it('keeps a claimed child over its claimed epic, not shared', () => {
    const issues = [
      issue('epic', { issue_type: 'epic' }),
      issue('sub', { issue_type: 'epic', parent: 'epic' }),
      issue('child', { parent: 'sub' }),
    ];
    const commands = [
      bdCommand('s1', 0, 'claim', 'epic'),
      bdCommand('s1', 1, 'claim', 'child'),
    ];
    const event = activity('s1', 5);
    const { attributions, rollup } = attribute([event], commands, issues);
    expect(attributions.get(event.event_id)).toEqual({
      issue_ids: ['child'],
      method: 'claim',
      shared: false,
    });
    expect(rollup.get('epic')).toEqual({
      own: [],
      rolled_up: [event.event_id],
    });
    expect(rollup.get('sub')?.rolled_up).toEqual([event.event_id]);
    expect(rollup.get('child')?.own).toEqual([event.event_id]);
  });

  it('keeps nested issues specific on the timestamp path too', () => {
    const window = { assignee: 'd', started_at: at(0), closed_at: at(60) };
    const issues = [
      issue('epic', { issue_type: 'epic', ...window }),
      issue('child', { parent: 'epic', ...window }),
    ];
    const event = activity('s9', 5);
    const { attributions } = attribute([event], [], issues);
    expect(attributions.get(event.event_id)).toEqual({
      issue_ids: ['child'],
      method: 'timestamp',
      shared: false,
    });
  });

  it('counts an event shared by sibling issues in full, once in their epic', () => {
    const issues = [
      issue('epic', { issue_type: 'epic' }),
      issue('a', { parent: 'epic' }),
      issue('b', { parent: 'epic' }),
    ];
    const commands = [
      bdCommand('s1', 0, 'claim', 'a'),
      bdCommand('s1', 1, 'claim', 'b'),
    ];
    const event = activity('s1', 5);
    const { attributions, rollup } = attribute([event], commands, issues);
    expect(attributions.get(event.event_id)).toEqual({
      issue_ids: ['a', 'b'],
      method: 'claim',
      shared: true,
    });
    expect(rollup.get('a')?.own).toEqual([event.event_id]);
    expect(rollup.get('b')?.own).toEqual([event.event_id]);
    expect(rollup.get('epic')?.rolled_up).toEqual([event.event_id]);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Issue facts travel with the attribution]]
  it('returns title, status and issue type for each issue', () => {
    const { issues } = attribute(
      [],
      [],
      [
        issue('x', { title: 'Fix it', status: 'closed', issue_type: 'bug' }),
        issue('y', { parent: 'x' }),
      ],
    );
    expect(issues.get('x')).toEqual({
      title: 'Fix it',
      status: 'closed',
      issue_type: 'bug',
      parent: null,
    });
    expect(issues.get('y')?.parent).toBe('x');
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Unattributed bucket]]
  it('leaves unmatched events unattributed and ignores unknown issues', () => {
    const commands = [bdCommand('s1', 0, 'claim', 'elsewhere-1')];
    const event = activity('s1', 5);
    const { attributions } = attribute([event], commands, [issue('x')]);
    expect(attributions.get(event.event_id)).toEqual({
      issue_ids: [],
      method: 'unattributed',
      shared: false,
    });
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#bd unavailable]]
  it('attributes nothing and never throws without a snapshot', async () => {
    const commands = [bdCommand('s1', 0, 'claim', 'x')];
    const event = activity('s1', 5);
    const { attributions } = attributeActivity([event], commands, null);
    expect(attributions.get(event.event_id)?.method).toBe('unattributed');

    expect(await createBdRunner({})(['list'])).toBeNull();
    const failing: BdRunner = async () => null;
    expect(await loadIssueGraph(failing)).toBeNull();
    expect(await createBdWatcher(failing, () => 'f').refresh()).toBeNull();
    const garbled: BdRunner = async () => 'not json';
    expect(await loadIssueGraph(garbled)).toBeNull();
    const missingBinary = createBdRunner({
      BEADS_DIR: '/nonexistent',
      PATH: '/nonexistent',
    });
    expect(await missingBinary(['list'])).toBeNull();
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Discovered-from links]]
  it('returns discovered-from links with types and creation times', async () => {
    const listed = [
      {
        ...issue('source', { issue_type: 'feature', created_at: at(-50) }),
      },
      {
        ...issue('found', { issue_type: 'bug', created_at: at(-10) }),
        dependencies: [
          {
            issue_id: 'found',
            depends_on_id: 'source',
            type: 'discovered-from',
            created_at: at(-9),
          },
          {
            issue_id: 'found',
            depends_on_id: 'epic',
            type: 'parent-child',
            created_at: at(-9),
          },
        ],
      },
    ];
    const run: BdRunner = async () => JSON.stringify(listed);
    const graph = await loadIssueGraph(run);
    expect(graph?.discoveredFrom).toEqual([
      {
        issueId: 'found',
        issueType: 'bug',
        issueCreatedAt: at(-10),
        discoveredFromId: 'source',
        discoveredFromType: 'feature',
        discoveredFromCreatedAt: at(-50),
        linkedAt: at(-9),
      },
    ]);
    expect(graph?.issues.find((i) => i.id === 'found')?.parent).toBe('epic');
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Reopen detection from the events journal]]
  it('detects a reopen in a journal captured from bd', () => {
    const records = CAPTURED_REOPEN_JOURNAL.trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord);
    const closeRow = records.find((r) => r.op === 'close');
    const afterReopen = records.filter((r) => r.seq > (closeRow?.seq ?? 0));
    // bd reopen clears closed_at: the later rows show no trace of the close.
    expect(closeRow?.issue).toHaveProperty('closed_at');
    for (const row of afterReopen)
      expect(row.issue).not.toHaveProperty('closed_at');

    // The reopen's reason journals a comment row and then an update row: one
    // reopen is reported, at the first row that is no longer closed.
    expect(findReopens(records, new Map())).toEqual([
      { issueId: 'tmp-dmw', ts: '2026-11-08T23:17:01Z', seq: 4 },
    ]);
  });

  it('continues a reopen replay across a tail boundary', () => {
    const records = CAPTURED_REOPEN_JOURNAL.trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord);
    const statuses = new Map<string, string>();
    expect(findReopens(records.slice(0, 3), statuses)).toEqual([]);
    expect(findReopens(records.slice(3), statuses)).toHaveLength(1);
  });

  it('misses a reopen whose close was pruned', () => {
    const pruned: JournalRecord[] = [
      {
        seq: 9,
        ts: at(9),
        op: 'update',
        issue_id: 'x',
        issue: { status: 'open' },
      },
    ];
    expect(findReopens(pruned, new Map())).toEqual([]);
  });

  // @lat: [[usage-bd-attribution#Usage bd Attribution#Watcher re-tails only when the database changes]]
  it('tails only on change and re-baselines when nothing was journaled', async () => {
    const journal: JournalRecord[] = [
      {
        seq: 1,
        ts: at(1),
        op: 'close',
        issue_id: 'x',
        issue: { status: 'closed' },
      },
    ];
    const calls: string[] = [];
    const run: BdRunner = async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'list') return JSON.stringify([issue('x')]);
      if (args[1] === 'export')
        return journal.map((r) => JSON.stringify(r)).join('\n');
      const since = Number(args[3]);
      return journal
        .filter((r) => r.seq > since)
        .map((r) => JSON.stringify(r))
        .join('\n');
    };
    let fingerprint = 'a';
    const watcher = createBdWatcher(run, () => fingerprint);

    expect((await watcher.refresh())?.reopens).toEqual([]);
    expect(calls).toEqual(['events export', 'list --all']);

    calls.length = 0;
    await watcher.refresh();
    expect(calls).toEqual([]);

    journal.push({
      seq: 2,
      ts: at(2),
      op: 'update',
      issue_id: 'x',
      issue: { status: 'open' },
    });
    fingerprint = 'b';
    const afterReopen = await watcher.refresh();
    expect(afterReopen?.reopens).toEqual([{ issueId: 'x', ts: at(2), seq: 2 }]);
    expect(calls).toEqual(['events tail', 'list --all']);

    // A sync changes the database without journal rows: re-baseline.
    calls.length = 0;
    fingerprint = 'c';
    const afterSync = await watcher.refresh();
    expect(calls).toEqual(['events tail', 'events export', 'list --all']);
    expect(afterSync?.reopens).toEqual([{ issueId: 'x', ts: at(2), seq: 2 }]);
  });
});
