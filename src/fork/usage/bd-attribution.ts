import type { SessionEvent } from './schema.js';
import {
  beadsDirFingerprint,
  createBdRunner,
  exportJournal,
  findReopens,
  loadIssueGraph,
  resolveBeadsDir,
  tailJournal,
  type BdIssue,
  type BdRunner,
  type DiscoveredFromLink,
  type ReopenEvent,
} from './bd-client.js';

/**
 * What attribution reads of a SessionEvent: the session link and time of every
 * kind, and the verb and issue of a bd command. Any SessionEvent fits, and so
 * does a slimmed copy that dropped other fields.
 */
export type AttributionSessionEvent = {
  session_id: string;
  ts: string;
  parent_session_id?: string;
} & (
  | { kind: 'bd_command'; verb: 'claim' | 'close'; issue_id: string }
  | { kind: Exclude<SessionEvent['kind'], 'bd_command'> }
);

/** What attribution needs of a UsageEvent or a SessionEvent. */
export interface Activity {
  event_id: string;
  session_id: string | null;
  parent_session_id?: string | null;
  ts: string;
}

export type AttributionMethod = 'claim' | 'timestamp' | 'unattributed';

export interface Attribution {
  /** Empty exactly when method is 'unattributed'. */
  issue_ids: string[];
  method: AttributionMethod;
  /** More than one issue was open for this event. */
  shared: boolean;
}

export interface IssueFacts {
  title: string;
  status: string;
  issue_type: string;
  /** The bd parent issue, or null for a top-level issue. */
  parent: string | null;
}

/** One read of bd: issue facts, hierarchy, and the lat-eah.40 inputs. */
export interface BdSnapshot {
  issues: BdIssue[];
  discoveredFrom: DiscoveredFromLink[];
  reopens: ReopenEvent[];
}

export interface IssueRollup {
  /** Events attributed to the issue itself. */
  own: string[];
  /** Own events plus every descendant's, each event once. */
  rolled_up: string[];
}

export interface AttributionResult {
  attributions: Map<string, Attribution>;
  issues: Map<string, IssueFacts>;
  rollup: Map<string, IssueRollup>;
}

const UNATTRIBUTED: Attribution = {
  issue_ids: [],
  method: 'unattributed',
  shared: false,
};

interface Interval {
  issueId: string;
  start: number;
  end: number;
}

/**
 * `bd update X --claim` opens an interval in its session. The first
 * `bd close X` in any session ends every interval open for X: a subagent may
 * close what its parent claimed. A repeated claim in a session whose interval
 * is still open is ignored. A close with no open interval in its own session
 * credits only that instant to it. The snapshot's closed_at caps an interval
 * nothing closed.
 */
function claimIntervals(
  sessionEvents: AttributionSessionEvent[],
  issues: BdIssue[],
): Map<string, Interval[]> {
  const known = new Set(issues.map((issue) => issue.id));
  const closedAt = new Map<string, number>();
  for (const issue of issues)
    if (issue.closed_at) closedAt.set(issue.id, Date.parse(issue.closed_at));
  const bySession = new Map<string, Interval[]>();
  const commands = sessionEvents
    .filter((event) => event.kind === 'bd_command')
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const command of commands) {
    if (command.kind !== 'bd_command') continue;
    if (!known.has(command.issue_id)) continue;
    const intervals = bySession.get(command.session_id) ?? [];
    bySession.set(command.session_id, intervals);
    const ts = Date.parse(command.ts);
    const isOpen = (i: Interval) =>
      i.issueId === command.issue_id && i.end === Infinity;
    if (command.verb === 'claim') {
      if (!intervals.some(isOpen))
        intervals.push({ issueId: command.issue_id, start: ts, end: Infinity });
      continue;
    }
    if (!intervals.some(isOpen))
      intervals.push({ issueId: command.issue_id, start: ts, end: ts });
    for (const sessionIntervals of bySession.values())
      for (const interval of sessionIntervals.filter(isOpen)) interval.end = ts;
  }
  for (const sessionIntervals of bySession.values())
    for (const interval of sessionIntervals) {
      const cap = closedAt.get(interval.issueId);
      if (
        interval.end === Infinity &&
        cap !== undefined &&
        cap >= interval.start
      )
        interval.end = cap;
    }
  return bySession;
}

function openIssues(intervals: Interval[] | undefined, ts: number): string[] {
  const ids = (intervals ?? [])
    .filter((i) => i.start <= ts && ts <= i.end)
    .map((i) => i.issueId);
  return [...new Set(ids)];
}

/**
 * An in_progress issue stops absorbing unclaimed events at its last recorded
 * bd activity (`updated_at`), so a stale issue does not take later work. A
 * snapshot without `updated_at` leaves the window open.
 */
function openEnd(issue: BdIssue & { updated_at?: string }): number {
  const updated = issue.updated_at ? Date.parse(issue.updated_at) : NaN;
  return Number.isNaN(updated) ? Infinity : updated;
}

function timestampIssues(issues: BdIssue[], ts: number): string[] {
  return issues
    .filter((issue) => {
      if (!issue.assignee || !issue.started_at) return false;
      const end = issue.closed_at
        ? Date.parse(issue.closed_at)
        : issue.status === 'in_progress'
          ? openEnd(issue)
          : -Infinity;
      return Date.parse(issue.started_at) <= ts && ts <= end;
    })
    .map((issue) => issue.id);
}

/**
 * Keeps the most specific issues: one that is an ancestor of another matched
 * issue gets the event through the rollup instead. What remains is shared
 * only when two or more unrelated issues remain.
 */
function attributed(
  issueIds: string[],
  method: 'claim' | 'timestamp',
  parentOf: Map<string, string>,
): Attribution {
  const ancestors = new Set<string>();
  for (const id of issueIds) {
    const visited = new Set([id]);
    for (
      let parent = parentOf.get(id);
      parent && !visited.has(parent);
      parent = parentOf.get(parent)
    ) {
      visited.add(parent);
      ancestors.add(parent);
    }
  }
  const specific = issueIds.filter((id) => !ancestors.has(id));
  return { issue_ids: specific, method, shared: specific.length > 1 };
}

/**
 * Map each activity to the bd issues it served.
 *
 * 1. Claim: events in a session between `bd update X --claim` and
 *    `bd close X` belong to X; several open at once are all credited and
 *    marked shared only when they are unrelated: when one is an ancestor of
 *    another, the ancestor is left to the rollup. A shared event counts in
 *    full in each issue's own list, so per-issue totals must not be summed.
 * 2. A subagent session with no open claim of its own is attributed through
 *    its parent session's claims (parent_session_id on the activity, or the
 *    link learned from any event), up the chain.
 * 3. Timestamp: between an assigned issue's started_at and closed_at, or its
 *    last bd activity (updated_at) while it is still in progress.
 * 4. Otherwise unattributed.
 *
 * A null snapshot (bd missing, no database) attributes nothing. A claim
 * naming an issue absent from the snapshot is ignored.
 */
export function attributeActivity(
  activity: Activity[],
  sessionEvents: AttributionSessionEvent[],
  snapshot: BdSnapshot | null,
): AttributionResult {
  const attributions = new Map<string, Attribution>();
  const issues = new Map<string, IssueFacts>();
  if (!snapshot) {
    for (const item of activity) attributions.set(item.event_id, UNATTRIBUTED);
    return { attributions, issues, rollup: new Map() };
  }
  for (const issue of snapshot.issues)
    issues.set(issue.id, {
      title: issue.title,
      status: issue.status,
      issue_type: issue.issue_type,
      parent: issue.parent ?? null,
    });

  const intervals = claimIntervals(sessionEvents, snapshot.issues);
  const issueParent = parentLinks(snapshot.issues);
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, Set<string>>();
  for (const item of [...sessionEvents, ...activity])
    if (item.session_id && item.parent_session_id) {
      parentOf.set(item.session_id, item.parent_session_id);
      const children = childrenOf.get(item.parent_session_id) ?? new Set();
      children.add(item.session_id);
      childrenOf.set(item.parent_session_id, children);
    }

  for (const item of activity) {
    const ts = Date.parse(item.ts);
    let claimed: string[] = [];
    const seen = new Set<string>();
    for (
      let session = item.session_id;
      session && !seen.has(session) && claimed.length === 0;
      session = parentOf.get(session) ?? null
    ) {
      seen.add(session);
      claimed = openIssues(intervals.get(session), ts);
    }
    // The CLI tap logs a subagent's lat commands under its parent's session
    // id, so a claim held by one direct child session covers them too.
    if (claimed.length === 0 && item.session_id) {
      const fromChildren = new Set<string>();
      for (const child of childrenOf.get(item.session_id) ?? [])
        for (const id of openIssues(intervals.get(child), ts))
          fromChildren.add(id);
      if (fromChildren.size === 1) claimed = [...fromChildren];
    }
    if (claimed.length > 0) {
      attributions.set(
        item.event_id,
        attributed(claimed, 'claim', issueParent),
      );
      continue;
    }
    const timed = timestampIssues(snapshot.issues, ts);
    attributions.set(
      item.event_id,
      timed.length > 0
        ? attributed(timed, 'timestamp', issueParent)
        : UNATTRIBUTED,
    );
  }
  return {
    attributions,
    issues,
    rollup: rollUp(snapshot.issues, attributions),
  };
}

function parentLinks(issues: BdIssue[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const issue of issues)
    if (issue.parent) parentOf.set(issue.id, issue.parent);
  return parentOf;
}

/**
 * Credit every issue with its own events plus its descendants', following
 * parent links at any depth and any issue type. An event credited to a parent
 * and its child counts once for the parent.
 */
export function rollUp(
  issues: BdIssue[],
  attributions: Map<string, Attribution>,
): Map<string, IssueRollup> {
  const parentOf = parentLinks(issues);

  const own = new Map<string, string[]>();
  for (const [eventId, attribution] of attributions)
    for (const issueId of attribution.issue_ids)
      (own.get(issueId) ?? own.set(issueId, []).get(issueId)!).push(eventId);

  const rolledUp = new Map<string, Set<string>>();
  for (const [issueId, eventIds] of own) {
    const visited = new Set<string>();
    for (
      let id: string | undefined = issueId;
      id && !visited.has(id);
      id = parentOf.get(id)
    ) {
      visited.add(id);
      const events = rolledUp.get(id) ?? new Set<string>();
      for (const eventId of eventIds) events.add(eventId);
      rolledUp.set(id, events);
    }
  }
  return new Map(
    [...rolledUp].map(([issueId, events]) => [
      issueId,
      { own: own.get(issueId) ?? [], rolled_up: [...events] },
    ]),
  );
}

export interface BdWatcher {
  /** Current snapshot; null when bd is unavailable. Cheap when nothing changed. */
  refresh(): Promise<BdSnapshot | null>;
}

/**
 * Keeps a BdSnapshot current. The database fingerprint gates every bd call.
 * When it changes, `bd events tail --since <checkpoint>` extends the reopen
 * list. A change with no journal rows (a sync pulled it in, which this
 * clone's journal never records), a failed tail (the checkpoint fell below
 * the retained floor) or a sequence behind the checkpoint re-baselines from
 * `bd events export`. A reload that yields the same issues, links and
 * reopens returns the previous snapshot object. A refresh made while another
 * is running returns the running one's snapshot, so callers that share a
 * watcher never advance the checkpoint twice. `root` is the project root that
 * picks the database (`resolveBeadsDir`).
 */
export function createBdWatcher(
  root: string,
  run: BdRunner = createBdRunner(root),
  fingerprint: () => string = () => beadsDirFingerprint(resolveBeadsDir(root)),
): BdWatcher {
  let lastFingerprint: string | null = null;
  let snapshot: BdSnapshot | null = null;
  let checkpoint = 0;
  let reopens: ReopenEvent[] = [];
  let closedSince = new Map<string, string>();

  async function rebaseline(): Promise<boolean> {
    const records = await exportJournal(run);
    if (!records) return false;
    closedSince = new Map();
    reopens = findReopens(records, closedSince);
    checkpoint = records.reduce((max, r) => Math.max(max, r.seq), 0);
    return true;
  }

  async function advance(): Promise<boolean> {
    if (lastFingerprint === null) return rebaseline();
    const records = await tailJournal(run, checkpoint);
    if (!records || records.length === 0) return rebaseline();
    if (records.some((r) => r.seq <= checkpoint)) return rebaseline();
    reopens = [...reopens, ...findReopens(records, closedSince)];
    checkpoint = records[records.length - 1].seq;
    return true;
  }

  async function reload(): Promise<BdSnapshot | null> {
    const current = fingerprint();
    if (current !== '' && current === lastFingerprint) return snapshot;
    const journaled = await advance();
    const graph = await loadIssueGraph(run);
    const next = graph ? { ...graph, reopens: journaled ? reopens : [] } : null;
    lastFingerprint = graph && journaled ? current : null;
    // Unchanged bd output keeps the previous object, so consumers that
    // compare snapshots by identity skip their rebuild.
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) snapshot = next;
    return snapshot;
  }

  let running: Promise<BdSnapshot | null> | null = null;
  return {
    refresh() {
      running ??= reload().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
