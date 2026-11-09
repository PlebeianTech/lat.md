// @lat: [[usage-missed-knowledge#Usage Missed Knowledge]]
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  dayOf,
  normalizeQuery,
  type AggregateContext,
  type Contribution,
  type Item,
} from './aggregate-types.js';
import {
  snapshotAt,
  type GraphSnapshot,
  type SnapshotResult,
} from './graph-snapshot.js';
import type { SlimSessionEvent } from './state.js';

const execFileAsync = promisify(execFile);

export const MISSED_KNOWLEDGE_METHOD_VERSION = 1;

export const OUTCOMES = [
  'reached',
  'read-late',
  'bypassed',
  'found-not-opened',
  'searched-not-found',
  'never-consulted',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface NoCoverage {
  new_file: number;
  undocumented: number;
  unclassified: number;
}

export interface ReachStats {
  sessions: number;
  measured_sessions: number;
  not_captured_sessions: number;
  no_edit_sessions: number;
  sessions_with_miss: number;
  expected_sections: number;
  reached: number;
  outcomes: Record<Outcome, number>;
  reach: number | null;
  reach_reason: string | null;
  no_coverage: NoCoverage;
}

export type SessionStatus = 'measured' | 'not_captured' | 'no_edits';

export interface SessionReach {
  session_id: string;
  agent: string | null;
  start: string | null;
  git_head: string | null;
  status: SessionStatus;
  reason: string | null;
  issue_ids: string[];
  issue_types: string[];
  expected_sections: number;
  reached: number;
  outcomes: Record<Outcome, number>;
  reach: number | null;
  reach_reason: string | null;
  had_a_miss: boolean;
  no_coverage: NoCoverage;
}

export interface OutcomeRecord {
  session_id: string;
  section_id: string;
  outcome: Outcome;
  session_start: string | null;
  git_head: string;
  queries_before_first_edit: string[] | null;
}

export interface DailyReach {
  day: string;
  sessions: number;
  expected_sections: number;
  reached: number;
  reach: number | null;
}

export interface MissedKnowledge {
  method_version: number;
  notes: {
    inferred_not_intended: string;
    measures_existing_documented_code: string;
  };
  totals: ReachStats;
  previous: ReachStats | null;
  daily: DailyReach[];
  by_issue_type: (ReachStats & { key: string })[];
  by_agent: (ReachStats & { key: string })[];
  by_issue: {
    key: string;
    issue_type: string;
    own: ReachStats;
    rolled_up: ReachStats;
  }[];
  sessions: SessionReach[];
  records: OutcomeRecord[];
  undocumented_files: { path: string; sessions: number; edits: number }[];
  unjoinable_events: number;
}

const NOTES = {
  inferred_not_intended:
    'The outcomes are inferred from what the agent did, not from what it intended.',
  measures_existing_documented_code:
    'Expected sections exist only for files that already had references at the head, so reach measures changes to existing, documented code.',
};

interface SessionInfo {
  id: string;
  agent: string | null;
  start: number | null;
  end: number | null;
  worktrees: Set<string>;
  events: SlimSessionEvent[];
}

interface Plan {
  sessions: Map<string, SessionInfo>;
  itemsBySession: Map<string, Item[]>;
  unjoinable: Set<string>;
}

export function collectSessions(context: AggregateContext) {
  const sessions = new Map<string, SessionInfo>();
  const infoFor = (id: string): SessionInfo => {
    let info = sessions.get(id);
    if (!info) {
      info = {
        id,
        agent: null,
        start: null,
        end: null,
        worktrees: new Set(),
        events: [],
      };
      sessions.set(id, info);
    }
    return info;
  };
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  const firsts = new Map<string, number>();
  const lasts = new Map<string, number>();
  const widen = (id: string, ts: number) => {
    firsts.set(id, Math.min(firsts.get(id) ?? ts, ts));
    lasts.set(id, Math.max(lasts.get(id) ?? ts, ts));
  };
  for (const event of context.sessionEvents) {
    infoFor(event.session_id).events.push(event);
    const ts = Date.parse(event.ts);
    widen(event.session_id, ts);
    if (event.kind === 'session_start')
      starts.set(
        event.session_id,
        Math.min(starts.get(event.session_id) ?? ts, ts),
      );
    if (event.kind === 'session_end')
      ends.set(
        event.session_id,
        Math.max(ends.get(event.session_id) ?? ts, ts),
      );
  }
  for (const item of context.allItems) {
    if (!item.session_id) continue;
    const info = infoFor(item.session_id);
    info.agent = info.agent ?? item.agent;
    if (item.usage?.worktree) info.worktrees.add(item.usage.worktree);
    widen(item.session_id, item.ts);
  }
  for (const info of sessions.values()) {
    info.start = starts.get(info.id) ?? firsts.get(info.id) ?? null;
    info.end = ends.get(info.id) ?? lasts.get(info.id) ?? null;
  }
  return sessions;
}

function joinByWindow(item: Item, sessions: Map<string, SessionInfo>) {
  const worktree = item.usage?.worktree ?? null;
  const matches = [...sessions.values()].filter(
    (session) =>
      item.agent !== null &&
      session.agent === item.agent &&
      session.start !== null &&
      session.end !== null &&
      session.start <= item.ts &&
      item.ts <= session.end &&
      (session.worktrees.size === 0 ||
        (worktree !== null && session.worktrees.has(worktree))),
  );
  return matches.length === 1 ? matches[0].id : null;
}

function buildPlan(context: AggregateContext): Plan {
  const sessions = collectSessions(context);
  const itemsBySession = new Map<string, Item[]>();
  const unjoinable = new Set<string>();
  const add = (id: string, item: Item) => {
    const items = itemsBySession.get(id) ?? [];
    items.push(item);
    itemsBySession.set(id, items);
  };
  for (const item of context.allItems) {
    if (item.session_id) {
      add(item.session_id, item);
      continue;
    }
    if (!item.usage) continue;
    const joined = joinByWindow(item, sessions);
    if (joined) add(joined, item);
    else if (item.usage.caller !== 'human') unjoinable.add(item.id);
  }
  return { sessions, itemsBySession, unjoinable };
}

interface ScopePlan {
  heads: Map<string, string | null>;
  worktreesByHead: Map<string, string[]>;
}

function latestHead(items: Item[]): string | null {
  let latest: string | null = null;
  let latestTs = -Infinity;
  for (const item of items) {
    const head = item.usage?.git_head;
    if (head && item.ts >= latestTs) {
      latest = head;
      latestTs = item.ts;
    }
  }
  return latest;
}

function scopePlan(plan: Plan, items: Item[]): ScopePlan {
  const inScope = new Set(items.map((item) => item.id));
  const rangeHead = latestHead(items);
  const heads = new Map<string, string | null>();
  for (const [id, sessionItems] of plan.itemsBySession) {
    if (!sessionItems.some((item) => inScope.has(item.id))) continue;
    heads.set(id, latestHead(sessionItems) ?? rangeHead);
  }
  const worktreesByHead = new Map<string, string[]>();
  const sessionItems = [...heads.keys()].flatMap(
    (id) => plan.itemsBySession.get(id) ?? [],
  );
  for (const item of [...items, ...sessionItems]) {
    const head = item.usage?.git_head;
    const worktree = item.usage?.worktree;
    if (!head || !worktree) continue;
    const worktrees = worktreesByHead.get(head) ?? [];
    if (!worktrees.includes(worktree)) worktrees.push(worktree);
    worktreesByHead.set(head, worktrees);
  }
  return { heads, worktreesByHead };
}

interface Loaded {
  prefix: string;
  snapshots: Map<string, SnapshotResult>;
  trees: Map<string, Set<string> | null>;
  shell: Map<string, string[]>;
}

const loaded = new Map<string, Loaded>();

export function forgetMissedKnowledge(): void {
  loaded.clear();
}

const newStore = (prefix: string): Loaded => ({
  prefix,
  snapshots: new Map(),
  trees: new Map(),
  shell: new Map(),
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

async function readPrefix(root: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', '--show-prefix'])).trim();
  } catch {
    return '';
  }
}

async function listTree(root: string, head: string) {
  try {
    const out = await git(root, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      '--end-of-options',
      head,
    ]);
    return new Set(out.split('\0').filter((file) => file !== ''));
  } catch {
    return null;
  }
}

const SECTION_COMMAND =
  /(?:^|[\s;&|(`])lat\s+section\s+("[^"]*"|'[^']*'|[^\s;&|)`]+)/g;

export function collectCommands(
  value: unknown,
  commands: string[],
  depth = 0,
): void {
  if (depth > 8) return;
  if (typeof value === 'string') {
    if (!value.startsWith('{')) return;
    try {
      collectCommands(JSON.parse(value), commands, depth + 1);
    } catch {
      return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) collectCommands(part, commands, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, part] of Object.entries(value)) {
    if (key === 'command' || key === 'cmd') {
      if (typeof part === 'string') commands.push(part);
      else if (Array.isArray(part) && part.every((p) => typeof p === 'string'))
        commands.push(part.join(' '));
    }
    collectCommands(part, commands, depth + 1);
  }
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export async function readLineAt(
  path: string,
  offset: number,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const chunks: Buffer[] = [];
    let position = offset;
    while (position - offset < MAX_LINE_BYTES) {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(buffer.subarray(0, newline));
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function sectionIdsAt(path: string, offset: number): Promise<string[]> {
  const line = await readLineAt(path, offset);
  if (line === null) return [];
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  const commands: string[] = [];
  collectCommands(record, commands);
  const ids = new Set<string>();
  for (const command of commands) {
    for (const match of command.matchAll(SECTION_COMMAND)) {
      const query = match[1].replace(/^(["'])(.*)\1$/, '$2');
      ids.add(query.replace(/^\[\[(.*)\]\]$/, '$1'));
    }
  }
  return [...ids];
}

function relativeToRoot(path: string | null, prefix: string): string | null {
  if (path === null || path === '' || path === '.' || path.startsWith('/'))
    return null;
  const clean = path.replace(/^\.\//, '');
  if (prefix === '') return clean;
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : null;
}

function editsOf(info: SessionInfo, prefix: string) {
  const edits = new Map<string, { first: number; count: number }>();
  for (const event of info.events) {
    if (event.kind !== 'tool_call' || event.tool.action !== 'edit') continue;
    const file = relativeToRoot(event.tool.path, prefix);
    if (file === null) continue;
    const ts = Date.parse(event.ts);
    const known = edits.get(file);
    if (known) {
      known.first = Math.min(known.first, ts);
      known.count++;
    } else edits.set(file, { first: ts, count: 1 });
  }
  return edits;
}

function isShellCandidate(event: SlimSessionEvent): boolean {
  if (event.kind !== 'tool_call' || event.tool.action !== 'shell') return false;
  const exit = event.tool.shell?.exit_code?.value;
  return (
    (exit === undefined || exit === null || exit === 0) &&
    event.source.path.endsWith('.jsonl')
  );
}

async function loadScope(
  root: string,
  plan: Plan,
  scope: ScopePlan,
  store: Loaded,
  lines: Map<string, string[]>,
): Promise<void> {
  const wanted = new Map(scope.worktreesByHead);
  for (const head of scope.heads.values())
    if (head && !wanted.has(head)) wanted.set(head, []);
  for (const [head, worktrees] of wanted) {
    if (!store.snapshots.has(head))
      store.snapshots.set(head, await snapshotAt(root, head, worktrees));
  }
  for (const [id, head] of scope.heads) {
    const info = plan.sessions.get(id);
    if (!info || editsOf(info, store.prefix).size === 0) continue;
    if (head && store.snapshots.get(head)?.snapshot && !store.trees.has(head))
      store.trees.set(head, await listTree(root, head));
    for (const event of info.events) {
      if (!isShellCandidate(event) || store.shell.has(event.event_id)) continue;
      const key = `${event.source.path}\0${event.source.offset}`;
      let ids = lines.get(key);
      if (!ids) {
        ids = await sectionIdsAt(event.source.path, event.source.offset);
        lines.set(key, ids);
      }
      store.shell.set(event.event_id, ids);
    }
  }
}

const sectionKey = (id: string) => id.replace(/^lat\.md\//, '').toLowerCase();

interface Coverage {
  byFile: Map<string, Map<string, string>>;
  sections: Set<string>;
  documents: Map<string, string>;
}

function coverageOf(snapshot: GraphSnapshot, prefix: string): Coverage {
  const names = new Map<string, string>();
  const documents = new Map<string, string>();
  for (const section of snapshot.sections) {
    names.set(sectionKey(section.id), section.id);
    documents.set(sectionKey(section.id), section.document);
  }
  const byFile = new Map<string, Map<string, string>>();
  const cover = (file: string, section: string) => {
    const key = sectionKey(section);
    const id = names.get(key);
    if (!id) return;
    const path = relativeToRoot(file, prefix) ?? file.replace(/^\.\//, '');
    const covered = byFile.get(path) ?? new Map<string, string>();
    covered.set(key, id);
    byFile.set(path, covered);
  };
  for (const edge of snapshot.code_ref_edges ?? [])
    cover(edge.file, edge.section);
  for (const edge of snapshot.symbol_ref_edges) cover(edge.file, edge.section);
  return { byFile, sections: new Set(names.keys()), documents };
}

const emptyOutcomes = () =>
  Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    Outcome,
    number
  >;
const noCoverage = (): NoCoverage => ({
  new_file: 0,
  undocumented: 0,
  unclassified: 0,
});

interface Measured {
  result: SessionReach;
  records: OutcomeRecord[];
  undocumented: Map<string, number>;
}

function sessionHeader(
  info: SessionInfo,
  head: string | null,
  plan: Plan,
  context: AggregateContext,
) {
  const issueIds = new Set<string>();
  for (const item of plan.itemsBySession.get(info.id) ?? [])
    for (const id of context.attribution.attributions.get(item.id)?.issue_ids ??
      [])
      issueIds.add(id);
  const types = new Set<string>();
  for (const id of issueIds)
    types.add(context.attribution.issues.get(id)?.issue_type ?? 'untyped');
  if (types.size === 0) types.add('unknown');
  return {
    session_id: info.id,
    agent: info.agent,
    start: info.start === null ? null : new Date(info.start).toISOString(),
    git_head: head,
    issue_ids: [...issueIds].sort(),
    issue_types: [...types].sort(),
  };
}

function unmeasured(
  header: ReturnType<typeof sessionHeader>,
  status: SessionStatus,
  reason: string,
): Measured {
  return {
    result: {
      ...header,
      status,
      reason,
      expected_sections: 0,
      reached: 0,
      outcomes: emptyOutcomes(),
      reach: null,
      reach_reason: reason,
      had_a_miss: false,
      no_coverage: noCoverage(),
    },
    records: [],
    undocumented: new Map(),
  };
}

function measureSession(
  info: SessionInfo,
  head: string | null,
  plan: Plan,
  context: AggregateContext,
  store: Loaded,
): Measured {
  const header = sessionHeader(info, head, plan, context);
  const edits = editsOf(info, store.prefix);
  if (edits.size === 0)
    return unmeasured(
      header,
      'no_edits',
      'no edits to files under the project root',
    );
  if (head === null)
    return unmeasured(header, 'not_captured', 'no git head in the range');
  const loadedSnapshot = store.snapshots.get(head);
  if (!loadedSnapshot?.snapshot)
    return unmeasured(
      header,
      'not_captured',
      `no snapshot of ${head}: ${loadedSnapshot?.reason ?? 'not loaded'}`,
    );
  const snapshot = loadedSnapshot.snapshot;
  if (
    snapshot.code_ref_edges === null &&
    snapshot.symbol_ref_edges.length === 0
  )
    return unmeasured(
      header,
      'not_captured',
      `snapshot of ${head} has no code-ref or symbol-ref edges`,
    );
  const coverage = coverageOf(snapshot, store.prefix);
  const tree = store.trees.get(head) ?? null;

  const expected = new Map<string, { id: string; firstEdit: number }>();
  const coverageCounts = noCoverage();
  const undocumented = new Map<string, number>();
  let firstEdit = Infinity;
  for (const [file, edit] of edits) {
    firstEdit = Math.min(firstEdit, edit.first);
    const covered = coverage.byFile.get(file);
    if (covered) {
      for (const [key, id] of covered) {
        const known = expected.get(key);
        if (known) known.firstEdit = Math.min(known.firstEdit, edit.first);
        else expected.set(key, { id, firstEdit: edit.first });
      }
    } else if (tree !== null && !tree.has(file)) {
      coverageCounts.new_file++;
    } else if (snapshot.code_ref_edges === null || tree === null) {
      coverageCounts.unclassified++;
    } else {
      coverageCounts.undocumented++;
      undocumented.set(file, edit.count);
    }
  }

  const reads = new Map<string, number[]>();
  const found = new Set<string>();
  const queries: { ts: number; query: string }[] = [];
  let searched = false;
  const addRead = (id: string, ts: number) => {
    const key = sectionKey(id);
    reads.set(key, [...(reads.get(key) ?? []), ts]);
  };
  for (const item of plan.itemsBySession.get(info.id) ?? []) {
    const usage = item.usage;
    if (!usage) continue;
    if (usage.section_id) addRead(usage.section_id, item.ts);
    const command = usage.command.split(' ')[0];
    if (command === 'expand')
      for (const id of usage.result_ids) addRead(id, item.ts);
    const isSearch =
      usage.caller !== 'human' &&
      usage.exit_code === 0 &&
      (command === 'search' ||
        (command === 'hook' &&
          usage.caller === 'hook-injected' &&
          usage.result_count !== null));
    if (!isSearch) continue;
    searched = true;
    for (const id of usage.result_ids) found.add(sectionKey(id));
    if (command === 'search' && usage.query)
      queries.push({ ts: item.ts, query: normalizeQuery(usage.query) });
  }

  const rawPaths = new Set<string>();
  for (const event of info.events) {
    if (event.kind === 'bypass_read') {
      const path = relativeToRoot(event.path, store.prefix);
      if (path) rawPaths.add(path);
    } else if (event.kind === 'tool_call') {
      if (event.tool.action === 'read' || event.tool.action === 'search') {
        const path = relativeToRoot(event.tool.path, store.prefix);
        if (path) rawPaths.add(path);
      }
      for (const id of store.shell.get(event.event_id) ?? [])
        if (coverage.sections.has(sectionKey(id)))
          addRead(id, Date.parse(event.ts));
    }
  }
  const isBypassed = (document: string) =>
    [...rawPaths].some(
      (path) =>
        path === document || document.startsWith(`${path.replace(/\/$/, '')}/`),
    );

  const queriesBeforeFirstEdit = [
    ...new Set(queries.filter((q) => q.ts < firstEdit).map((q) => q.query)),
  ];
  const outcomes = emptyOutcomes();
  const records: OutcomeRecord[] = [];
  const ordered = [...expected].sort((a, b) => a[1].id.localeCompare(b[1].id));
  for (const [key, section] of ordered) {
    const times = reads.get(key) ?? [];
    let outcome: Outcome;
    if (times.some((ts) => ts < section.firstEdit)) outcome = 'reached';
    else if (times.length > 0) outcome = 'read-late';
    else if (isBypassed(coverage.documents.get(key) ?? ''))
      outcome = 'bypassed';
    else if (found.has(key)) outcome = 'found-not-opened';
    else if (searched) outcome = 'searched-not-found';
    else outcome = 'never-consulted';
    outcomes[outcome]++;
    records.push({
      session_id: info.id,
      section_id: section.id,
      outcome,
      session_start: header.start,
      git_head: head,
      queries_before_first_edit:
        outcome === 'searched-not-found' ? queriesBeforeFirstEdit : null,
    });
  }
  const count = records.length;
  return {
    result: {
      ...header,
      status: 'measured',
      reason: null,
      expected_sections: count,
      reached: outcomes.reached,
      outcomes,
      reach: count === 0 ? null : outcomes.reached / count,
      reach_reason: count === 0 ? 'no expected sections' : null,
      had_a_miss: count > outcomes.reached,
      no_coverage: coverageCounts,
    },
    records,
    undocumented,
  };
}

function statsOf(results: SessionReach[]): ReachStats {
  const outcomes = emptyOutcomes();
  const coverage = noCoverage();
  let expected = 0;
  let measured = 0;
  let notCaptured = 0;
  let noEdits = 0;
  let misses = 0;
  for (const result of results) {
    expected += result.expected_sections;
    if (result.status === 'measured') measured++;
    else if (result.status === 'not_captured') notCaptured++;
    else noEdits++;
    if (result.had_a_miss) misses++;
    for (const outcome of OUTCOMES)
      outcomes[outcome] += result.outcomes[outcome];
    coverage.new_file += result.no_coverage.new_file;
    coverage.undocumented += result.no_coverage.undocumented;
    coverage.unclassified += result.no_coverage.unclassified;
  }
  let reason: string | null = null;
  if (expected === 0)
    reason = measured === 0 ? 'no measured sessions' : 'no expected sections';
  return {
    sessions: results.length,
    measured_sessions: measured,
    not_captured_sessions: notCaptured,
    no_edit_sessions: noEdits,
    sessions_with_miss: misses,
    expected_sections: expected,
    reached: outcomes.reached,
    outcomes,
    reach: expected === 0 ? null : outcomes.reached / expected,
    reach_reason: reason,
    no_coverage: coverage,
  };
}

function groupedStats(
  results: SessionReach[],
  keys: (result: SessionReach) => string[],
) {
  const groups = new Map<string, SessionReach[]>();
  for (const result of results)
    for (const key of keys(result))
      groups.set(key, [...(groups.get(key) ?? []), result]);
  return [...groups]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => ({ key, ...statsOf(group) }));
}

function measureScope(
  items: Item[],
  plan: Plan,
  context: AggregateContext,
  store: Loaded,
) {
  const heads = [...scopePlan(plan, items).heads].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const measured: Measured[] = [];
  for (const [id, head] of heads) {
    const info = plan.sessions.get(id);
    if (info) measured.push(measureSession(info, head, plan, context, store));
  }
  return measured;
}

export const missedKnowledgeContribution: Contribution = {
  key: 'missed_knowledge',
  async prepare(context) {
    const plan = buildPlan(context);
    const store =
      loaded.get(context.root) ?? newStore(await readPrefix(context.root));
    loaded.set(context.root, store);
    const lines = new Map<string, string[]>();
    const scopes = [context.items];
    if (context.previousItems) scopes.push(context.previousItems);
    for (const items of scopes)
      await loadScope(context.root, plan, scopePlan(plan, items), store, lines);
  },
  compute(context): MissedKnowledge {
    const store = loaded.get(context.root) ?? newStore('');
    const plan = buildPlan(context);
    const current = measureScope(context.items, plan, context, store);
    const results = current.map((measured) => measured.result);
    const previous = context.previousItems
      ? statsOf(
          measureScope(context.previousItems, plan, context, store).map(
            (measured) => measured.result,
          ),
        )
      : null;

    const undocumented = new Map<string, { sessions: number; edits: number }>();
    for (const measured of current)
      for (const [path, edits] of measured.undocumented) {
        const row = undocumented.get(path) ?? { sessions: 0, edits: 0 };
        row.sessions++;
        row.edits += edits;
        undocumented.set(path, row);
      }

    const byDay = new Map<string, SessionReach[]>();
    for (const result of results) {
      if (result.start === null) continue;
      const day = dayOf(Date.parse(result.start));
      byDay.set(day, [...(byDay.get(day) ?? []), result]);
    }
    const days = context.days;

    const rolledSessions = new Map<string, Set<string>>();
    for (const result of results)
      for (const item of plan.itemsBySession.get(result.session_id) ?? [])
        for (const id of context.rolledIssues.get(item.id) ?? []) {
          const sessions = rolledSessions.get(id) ?? new Set<string>();
          sessions.add(result.session_id);
          rolledSessions.set(id, sessions);
        }

    const scopeIds = new Set(context.items.map((item) => item.id));
    return {
      method_version: MISSED_KNOWLEDGE_METHOD_VERSION,
      notes: NOTES,
      totals: statsOf(results),
      previous,
      daily: days.map((day) => {
        const { sessions, expected_sections, reached, reach } = statsOf(
          byDay.get(day) ?? [],
        );
        return { day, sessions, expected_sections, reached, reach };
      }),
      by_issue_type: groupedStats(results, (result) => result.issue_types),
      by_agent: groupedStats(results, (result) => [result.agent ?? 'unknown']),
      by_issue: [...rolledSessions]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, sessionIds]) => ({
          key,
          issue_type:
            context.attribution.issues.get(key)?.issue_type ?? 'untyped',
          own: statsOf(results.filter((r) => r.issue_ids.includes(key))),
          rolled_up: statsOf(
            results.filter((r) => sessionIds.has(r.session_id)),
          ),
        })),
      sessions: results,
      records: current.flatMap((measured) => measured.records),
      undocumented_files: [...undocumented]
        .map(([path, row]) => ({ path, ...row }))
        .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)),
      unjoinable_events: [...plan.unjoinable].filter((id) => scopeIds.has(id))
        .length,
    };
  },
};
