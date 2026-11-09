/**
 * Snapshots of the lat.md graph per git head, for the usage aggregation.
 *
 * A snapshot lists every section with its byte size and content hash, every
 * document with its bytes, every code-ref edge from a source file to the
 * section it references, and every symbol-ref wikilink edge keyed by the
 * file part of its target. One snapshot per head is cached in
 * <root>/.lat/usage/graph-snapshots. The contribution built on them gives
 * the never-read sections of the selected range and per-document reads.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseSections, type Section } from '@plebeiantech/lat.md-core/lattice';
import { buildGraph, type GraphSourceFile } from '../../graph-export.js';
import { isSectionRead, type Contribution } from './aggregate-types.js';
import {
  existingUsageDirectory,
  readRegularFile,
  realUsageDirectory,
} from './enabled.js';
import { worktreeRoots } from './sources/worktrees.js';

const execFileAsync = promisify(execFile);

export interface SnapshotSection {
  id: string;
  document: string;
  /** Null when the size could not be measured. */
  bytes: number | null;
  /** The section body hash buildGraph computes. */
  hash: string;
}

export interface SnapshotDocument {
  path: string;
  bytes: number;
}

export interface CodeRefEdge {
  file: string;
  line: number;
  section: string;
}

export interface SymbolRefEdge {
  section: string;
  /** The file part of a file#symbol target. */
  file: string;
}

/** Why code refs were not captured at a head. */
export type CodeRefReason = 'not_captured' | 'dirty_worktree';

export interface GraphSnapshot {
  git_head: string;
  sections: SnapshotSection[];
  documents: SnapshotDocument[];
  /** Null when no worktree at the head was available to scan. */
  code_ref_edges: CodeRefEdge[] | null;
  code_ref_edges_reason: CodeRefReason | null;
  symbol_ref_edges: SymbolRefEdge[];
}

export interface KnowledgeDocument {
  path: string;
  bytes: number;
  reads: number;
  sections_read: number;
}

export interface KnowledgeBreakdown {
  /** The snapshot at the range's latest git head; null when there is none. */
  snapshot: GraphSnapshot | null;
  /** Why the latest head has no snapshot; null otherwise. */
  snapshot_reason: string | null;
  /** Heads of the range that could not be snapshotted. */
  unavailable_heads: { git_head: string; reason: string }[];
  never_read_sections: SnapshotSection[];
  documents: KnowledgeDocument[];
}

const snapshotFile = (root: string, head: string) =>
  join(root, '.lat', 'usage', 'graph-snapshots', `${head}.json`);

/** Own-prose byte sizes by section id, over the files of one head. */
function sectionBytes(
  files: GraphSourceFile[],
  root: string,
): Map<string, number> {
  const bytes = new Map<string, number>();
  const walk = (section: Section, lines: string[]) => {
    const body = lines.slice(section.startLine, section.endLine).join('\n');
    bytes.set(section.id, Buffer.byteLength(body));
    for (const child of section.children) walk(child, lines);
  };
  for (const file of files) {
    const lines = file.content.replace(/\r\n/g, '\n').split('\n');
    for (const top of parseSections(
      join(root, file.relPath),
      file.content,
      root,
    )) {
      walk(top, lines);
    }
  }
  return bytes;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A project below the repository root gets snapshots]]
async function revisionFiles(
  root: string,
  head: string,
): Promise<GraphSourceFile[]> {
  let listed: string;
  try {
    listed = (
      await execFileAsync(
        'git',
        [
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          '--end-of-options',
          head,
          '--',
          'lat.md',
        ],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER },
      )
    ).stdout;
  } catch (err) {
    throw new Error(
      `failed to list "lat.md" at revision "${head}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const files: GraphSourceFile[] = [];
  for (const path of listed.split('\0').filter((p) => p.endsWith('.md'))) {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${head}:./${path}`],
      {
        cwd: root,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    files.push({ relPath: path, content: stdout });
  }
  return files;
}

/**
 * Builds the snapshot of a head. With a worktree that is at the head, code
 * refs are scanned in it; without one they are not captured.
 */
export async function snapshotGraphAtHead(
  root: string,
  head: string,
  worktree: string | null,
  codeRefReason: CodeRefReason = 'not_captured',
): Promise<GraphSnapshot> {
  const files = await revisionFiles(root, head);
  const scanRoot =
    worktree === null
      ? root
      : join(worktree, await git(root, 'rev-parse', '--show-prefix'));
  const graph = await buildGraph(files, scanRoot, worktree !== null);
  const bytes = sectionBytes(files, scanRoot);

  const sections: SnapshotSection[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'section' || !node.file || !node.bodyHash) continue;
    const id = node.id.slice('section:'.length);
    sections.push({
      id,
      document: node.file,
      bytes: bytes.get(id) ?? null,
      hash: node.bodyHash,
    });
  }
  const documents = files.map((file) => ({
    path: file.relPath,
    bytes: Buffer.byteLength(file.content),
  }));

  const symbolRefEdges: SymbolRefEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.type === 'wikilink' && edge.role === 'symbol-ref') {
      symbolRefEdges.push({
        section: edge.from.slice('section:'.length),
        file: edge.to.slice('code:'.length).split('#')[0],
      });
    }
  }

  let codeRefEdges: CodeRefEdge[] | null = null;
  if (worktree !== null) {
    codeRefEdges = [];
    for (const edge of graph.edges) {
      if (edge.type !== 'code-ref') continue;
      const location = edge.from.slice('code:'.length);
      const split = location.lastIndexOf(':');
      codeRefEdges.push({
        file: location.slice(0, split),
        line: Number(location.slice(split + 1)),
        section: edge.to.slice('section:'.length),
      });
    }
  }

  return {
    git_head: head,
    sections,
    documents,
    code_ref_edges: codeRefEdges,
    code_ref_edges_reason: codeRefEdges === null ? codeRefReason : null,
    symbol_ref_edges: symbolRefEdges,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/**
 * The first worktree at the head whose tree is clean, which is the one whose
 * code refs describe the commit. A dirty one is reported so the snapshot can
 * say why it has no code refs.
 */
async function findWorktreeAtHead(
  head: string,
  candidates: string[],
): Promise<{ clean: string | null; dirty: boolean }> {
  let dirty = false;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if ((await git(candidate, 'rev-parse', 'HEAD')) !== head) continue;
      if ((await git(candidate, 'status', '--porcelain')) === '') {
        return { clean: candidate, dirty };
      }
      dirty = true;
    } catch {
      continue;
    }
  }
  return { clean: null, dirty };
}

/**
 * The candidates that are worktrees of the project's repository. Candidates
 * come from event lines, and running git in a directory with a hostile
 * `.git/config` (core.fsmonitor) runs its code, so any other is dropped.
 */
// @lat: [[usage-graph-snapshot#Usage Graph Snapshot#A worktree outside the repository is never run]]
async function trustedWorktrees(
  root: string,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const roots = new Set((await worktreeRoots(root)).map(real));
  return candidates.filter((candidate) => roots.has(real(candidate)));
}

const snapshotDir = (root: string) =>
  join(root, '.lat', 'usage', 'graph-snapshots');

/** Silent, like every cache step: the snapshot can always be rebuilt. */
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    return;
  }
}

/** A planted symlink, FIFO or device at the cache file is never read. */
// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]
function readCachedSnapshot(path: string): GraphSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readRegularFile(path)) as GraphSnapshot;
  } catch {
    removeFile(path);
    return null;
  }
}

// @lat: [[usage-analytics#Usage Analytics#Opt-in and the usage directory]]
function writeCachedSnapshot(
  root: string,
  head: string,
  snapshot: GraphSnapshot,
): void {
  try {
    if (existingUsageDirectory(root) === null) return;
    mkdirSync(snapshotDir(root), { recursive: true });
    if (realUsageDirectory(root, 'graph-snapshots') === null) return;
    const temp = `${snapshotFile(root, head)}.${process.pid}.tmp`;
    removeFile(temp);
    writeFileSync(temp, JSON.stringify(snapshot), { flag: 'wx' });
    renameSync(temp, snapshotFile(root, head));
  } catch {
    return;
  }
}

export type SnapshotResult =
  | { snapshot: GraphSnapshot; reason: null }
  | { snapshot: null; reason: string };

/** Loaded snapshots and failures by project root and head, for this process. */
const remembered = new Map<string, SnapshotResult>();

/** Forgets what this process loaded, so the next call reads the disk again. */
export function forgetSnapshots(): void {
  remembered.clear();
}

/** A full SHA-1 or SHA-256 object id. */
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The snapshot of one head: from memory, else the disk cache, else built and
 * cached. A head that cannot be built is remembered with its reason. The head
 * comes from event lines, so anything but a full commit id is refused before
 * it reaches a file path or a git argument.
 */
export async function snapshotAt(
  root: string,
  head: string,
  worktrees: string[] = [],
): Promise<SnapshotResult> {
  if (!COMMIT_ID.test(head))
    return { snapshot: null, reason: 'git head is not a full commit id' };
  const key = `${root}\0${head}`;
  const known = remembered.get(key);
  if (known) return known;
  let result: SnapshotResult;
  try {
    // A symlinked cache directory points outside the project: skip it.
    const cached = realUsageDirectory(root, 'graph-snapshots') !== null;
    let snapshot = cached ? readCachedSnapshot(snapshotFile(root, head)) : null;
    if (!snapshot) {
      const found = await findWorktreeAtHead(
        head,
        await trustedWorktrees(root, worktrees),
      );
      snapshot = await snapshotGraphAtHead(
        root,
        head,
        found.clean,
        found.dirty ? 'dirty_worktree' : 'not_captured',
      );
      writeCachedSnapshot(root, head, snapshot);
    }
    result = { snapshot, reason: null };
  } catch (err) {
    result = {
      snapshot: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  remembered.set(key, result);
  return result;
}

export const graphSnapshotContribution: Contribution = {
  key: 'knowledge',
  async compute({ root, items }) {
    const worktreesByHead = new Map<string, string[]>();
    for (const item of items) {
      const head = item.usage?.git_head;
      if (!head) continue;
      const worktrees = worktreesByHead.get(head) ?? [];
      const worktree = item.usage?.worktree;
      if (worktree && !worktrees.includes(worktree)) worktrees.push(worktree);
      worktreesByHead.set(head, worktrees);
    }

    const results = new Map<string, SnapshotResult>();
    const unavailable: { git_head: string; reason: string }[] = [];
    for (const [head, worktrees] of worktreesByHead) {
      const result = await snapshotAt(root, head, worktrees);
      results.set(head, result);
      if (result.snapshot === null) {
        unavailable.push({ git_head: head, reason: result.reason });
      }
    }

    let latestHead: string | null = null;
    let latestTs = -Infinity;
    for (const item of items) {
      const head = item.usage?.git_head;
      if (head && item.ts >= latestTs) {
        latestHead = head;
        latestTs = item.ts;
      }
    }
    const latest = latestHead ? results.get(latestHead) : undefined;
    const snapshot = latest?.snapshot ?? null;
    if (!snapshot) {
      const empty: KnowledgeBreakdown = {
        snapshot: null,
        snapshot_reason: latest?.reason ?? null,
        unavailable_heads: unavailable,
        never_read_sections: [],
        documents: [],
      };
      return empty;
    }

    const readIds = new Set<string>();
    const readCounts = new Map<string, number>();
    for (const item of items) {
      if (!isSectionRead(item)) continue;
      const id = item.usage!.section_id!;
      readIds.add(id);
      readCounts.set(id, (readCounts.get(id) ?? 0) + 1);
    }

    const documents = snapshot.documents.map((document) => {
      const own = snapshot.sections.filter((s) => s.document === document.path);
      return {
        path: document.path,
        bytes: document.bytes,
        reads: own.reduce((sum, s) => sum + (readCounts.get(s.id) ?? 0), 0),
        sections_read: own.filter((s) => readIds.has(s.id)).length,
      };
    });
    const breakdown: KnowledgeBreakdown = {
      snapshot,
      snapshot_reason: null,
      unavailable_heads: unavailable,
      never_read_sections: snapshot.sections.filter((s) => !readIds.has(s.id)),
      documents,
    };
    return breakdown;
  },
};
