import { execFile, type ExecFileOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openRegularFile } from './enabled.js';

/**
 * Runs `bd <args>` and returns stdout, or null when bd is missing, finds no
 * database, the call fails or times out. It never throws.
 */
export type BdRunner = (args: string[]) => Promise<string | null>;

const CALL_TIMEOUT_MS = 15_000;
// `bd list --all --json` carries every issue description.
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function projectBeadsDir(root: string): string | undefined {
  const dir = join(root, '.beads');
  try {
    return statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bd database directory of a project root: its own `.beads/` first, so a
 * project database wins even when BEADS_DIR is exported for the whole machine;
 * else BEADS_DIR; else undefined, and bd searches for a database itself.
 */
export function resolveBeadsDir(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return projectBeadsDir(root) ?? (env.BEADS_DIR || undefined);
}

/**
 * Async execFile with stdin closed at once: a bd that reads stdin sees end of
 * input instead of waiting on it. execFile ignores a `stdio` option and always
 * opens stdin as a pipe, so the runner ends that pipe itself.
 *
 * Where bd runs follows `resolveBeadsDir`. A project `.beads/` runs bd in the
 * project root without BEADS_DIR. Only a BEADS_DIR with no project database
 * keeps the process working directory and passes BEADS_DIR on. With neither,
 * bd runs in the project root and finds its database itself.
 */
export function createBdRunner(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): BdRunner {
  return (args) =>
    new Promise((resolvePromise) => {
      const { BEADS_DIR: beadsDir, ...withoutBeadsDir } = env;
      const project = projectBeadsDir(root) !== undefined;
      const options = {
        timeout: CALL_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf-8',
        env: project || !beadsDir ? withoutBeadsDir : env,
        ...(project || !beadsDir ? { cwd: root } : {}),
      } as ExecFileOptions;
      const child = execFile('bd', args, options, (error, stdout) => {
        resolvePromise(error ? null : String(stdout));
      });
      child.stdin?.end();
    });
}

export interface BdIssue {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  assignee?: string;
  created_at: string;
  started_at?: string;
  closed_at?: string;
  parent?: string;
}

export interface BdDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
  created_at: string;
}

/** `issueId` was discovered while working on `discoveredFromId`. */
export interface DiscoveredFromLink {
  issueId: string;
  issueType: string;
  issueCreatedAt: string;
  discoveredFromId: string;
  discoveredFromType: string;
  discoveredFromCreatedAt: string;
  linkedAt: string;
}

export interface JournalRecord {
  seq: number;
  ts: string;
  op: string;
  issue_id: string;
  issue: { status?: string; closed_at?: string } | null;
}

export interface ReopenEvent {
  issueId: string;
  ts: string;
  seq: number;
  /** When the issue was closed before this reopen, from the journal. */
  closedTs: string;
}

interface ListedIssue extends BdIssue {
  dependencies?: BdDependency[];
}

export interface IssueGraph {
  issues: BdIssue[];
  discoveredFrom: DiscoveredFromLink[];
}

/** One `bd list --all --json -n 0` call: facts, parent-child and discovered-from. */
export async function loadIssueGraph(
  run: BdRunner,
): Promise<IssueGraph | null> {
  const stdout = await run(['list', '--all', '--json', '-n', '0']);
  if (stdout === null) return null;
  let listed: ListedIssue[];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    listed = parsed as ListedIssue[];
  } catch {
    return null;
  }
  const byId = new Map(listed.map((issue) => [issue.id, issue]));
  const discoveredFrom: DiscoveredFromLink[] = [];
  const issues = listed.map((listedIssue) => {
    const { dependencies = [], ...issue } = listedIssue;
    for (const dep of dependencies) {
      if (dep.type === 'parent-child' && !issue.parent)
        issue.parent = dep.depends_on_id;
      const source = byId.get(dep.depends_on_id);
      if (dep.type === 'discovered-from' && source)
        discoveredFrom.push({
          issueId: issue.id,
          issueType: issue.issue_type,
          issueCreatedAt: issue.created_at,
          discoveredFromId: source.id,
          discoveredFromType: source.issue_type,
          discoveredFromCreatedAt: source.created_at,
          linkedAt: dep.created_at,
        });
    }
    return issue;
  });
  return { issues, discoveredFrom };
}

function parseJournal(stdout: string): JournalRecord[] | null {
  const records: JournalRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch {
      return null;
    }
  }
  return records;
}

/** The whole retained journal. */
export async function exportJournal(
  run: BdRunner,
): Promise<JournalRecord[] | null> {
  const stdout = await run(['events', 'export']);
  return stdout === null ? null : parseJournal(stdout);
}

/**
 * Records after `since`. Null when the call fails, which includes the
 * events_journal_truncated refusal for a checkpoint older than the retained
 * floor: the caller re-baselines.
 */
export async function tailJournal(
  run: BdRunner,
  since: number,
): Promise<JournalRecord[] | null> {
  const stdout = await run(['events', 'tail', '--since', String(since)]);
  return stdout === null ? null : parseJournal(stdout);
}

/**
 * Reopen source: the events journal (bd_events_journal), not closed_at.
 *
 * `bd reopen` sets status to open and clears closed_at, so a snapshot of the
 * issue keeps no trace of the earlier close. The journal has no reopen op
 * (create, update, close, delete, dep_add, dep_remove, comment only); a
 * reopen is the first record after a close whose after-state is not closed.
 * Verified against a throwaway database on 2026-11-08: `bd reopen --reason`
 * journals a `comment` row (status already open) and then an `update` row, so
 * the op cannot be the test. closed_at is gone from the after-state and from `bd show`.
 * `closedSince` maps each issue that is closed now to the time it was
 * closed, and carries across calls so a tail can continue a replay. It lets
 * the reopen report when the issue was closed even after `closed_at` is gone.
 * The time is the close row's `closed_at`, else its ts.
 *
 * Reach: the journal covers this clone only (a pulled sync journals nothing)
 * and is pruned to events-journal-retain-days (7 here) and 100k rows. A reopen
 * whose preceding close was pruned cannot be told from an ordinary edit and is
 * missed.
 */
export function findReopens(
  records: JournalRecord[],
  closedSince: Map<string, string>,
): ReopenEvent[] {
  const reopens: ReopenEvent[] = [];
  for (const record of records) {
    const status = record.issue?.status;
    if (record.op === 'delete') {
      closedSince.delete(record.issue_id);
      continue;
    }
    if (!status) continue;
    const closedTs = closedSince.get(record.issue_id);
    if (status === 'closed') {
      // A later edit of a closed issue keeps the first close time.
      if (closedTs === undefined)
        closedSince.set(record.issue_id, record.issue?.closed_at ?? record.ts);
      continue;
    }
    if (record.op !== 'close' && closedTs !== undefined)
      reopens.push({
        issueId: record.issue_id,
        ts: record.ts,
        seq: record.seq,
        closedTs,
      });
    closedSince.delete(record.issue_id);
  }
  return reopens;
}

/**
 * Cheap change probe: a hash of each embedded Dolt database's noms manifest,
 * which Dolt changes on every commit. Content, not mtime, because every bd
 * command, read-only ones included, rewrites the manifest with the same bytes.
 * Entries with no manifest, such as the `.lock` file, are skipped. Unchanged
 * means the database is unchanged, so the roughly 220 ms `bd events tail` is
 * skipped. An unresolved or unreadable store gives '', which the watcher treats
 * as changed. Callers pass `resolveBeadsDir(root)`.
 */
export function beadsDirFingerprint(beadsDir: string | undefined): string {
  if (!beadsDir) return '';
  try {
    const root = join(beadsDir, 'embeddeddolt');
    const parts: string[] = [];
    for (const database of readdirSync(root).sort()) {
      const manifest = join(root, database, '.dolt', 'noms', 'manifest');
      let bytes: Buffer;
      try {
        const fd = openRegularFile(manifest);
        try {
          bytes = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const hash = createHash('sha256').update(bytes);
      parts.push(`${database}:${hash.digest('hex')}`);
    }
    return parts.join(',');
  } catch {
    return '';
  }
}
