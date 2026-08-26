// Export the whole lat.md knowledge graph: sections, documents, code refs,
// wiki links, and test-spec coverage, at the working tree or at a git
// revision. See lat-t1y.10.
//
// Every label placed into a mermaid or dot rendering is repository text, so
// it is passed through `cleanUntrustedId` before it becomes a node id or
// label -- never a hand-rolled sanitizer. `cleanUntrustedId` (not
// `quoteUntrusted`) is correct here: node ids and labels must not be
// truncated, and quoting them would corrupt them as identifiers.
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  extractRefs,
  buildFileIndex,
  buildSectionSlugIndex,
  parseSections,
  parseFrontmatter,
  resolveRef,
  type Section,
} from './lattice.js';
import { scanCodeRefs } from './code-refs.js';
import { DIATAXIS_MODES, MODE_DIRS } from './cli/check-mode.js';
import { readProvenance } from './cli/check-status.js';
import { cleanUntrustedId } from './untrusted.js';
import { toPosix } from './walk.js';

const execFileAsync = promisify(execFile);

export type GraphNodeType = 'document' | 'section' | 'code' | 'tag';
export type GraphEdgeType = 'contains' | 'wikilink' | 'code-ref' | 'tag';

export type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  file?: string;
  mode?: string;
  status?: string;
  reviewedHash?: string;
};

export type GraphEdge = {
  from: string;
  to: string;
  type: GraphEdgeType;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

/** A lat.md markdown file's project-root-relative path and content. */
export type GraphSourceFile = {
  /** Project-root-relative, posix-separated path (e.g. "lat.md/tests.md"). */
  relPath: string;
  content: string;
};

function docId(relPath: string): string {
  return `doc:${relPath}`;
}
function sectionId(id: string): string {
  return `section:${id}`;
}
function codeId(target: string): string {
  return `code:${target}`;
}
function tagId(tag: string): string {
  return `tag:${tag}`;
}

function modeForFile(
  relPath: string,
  fm: Record<string, unknown>,
): string | undefined {
  const declared = fm['mode'];
  if (typeof declared === 'string') return declared;
  for (const mode of DIATAXIS_MODES) {
    const dir = MODE_DIRS[mode];
    if (relPath.includes(`/${dir}/`) || relPath.startsWith(`${dir}/`)) {
      return mode;
    }
  }
  return undefined;
}

function tagsForFile(fm: Record<string, unknown>): string[] {
  const raw = fm['tags'];
  if (Array.isArray(raw))
    return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}

/**
 * Build the knowledge graph from a set of already-loaded lat.md file
 * contents. Used for both the working tree and a reconstructed git
 * revision -- the only difference between the two call sites is where the
 * file contents came from.
 *
 * `includeCode` controls whether the code-ref and source-wikilink halves of
 * the graph are built by scanning the live project tree on disk. This is
 * only meaningful for the working tree: a git revision's source tree is not
 * reconstructed, only its lat.md/ documents are, so `includeCode` is false
 * for `--at` / `--since`.
 */
export async function buildGraph(
  files: GraphSourceFile[],
  projectRoot: string,
  includeCode: boolean,
): Promise<Graph> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: GraphEdge) => {
    edges.push(edge);
  };
  const ensureSectionNode = (id: string, label?: string) => {
    const sid = sectionId(id);
    if (!nodes.has(sid)) {
      addNode({
        id: sid,
        type: 'section',
        label: cleanUntrustedId(label ?? id),
      });
    }
    return sid;
  };

  const allSections: Section[] = [];
  const sortedFiles = [...files].sort((a, b) =>
    a.relPath.localeCompare(b.relPath),
  );

  for (const f of sortedFiles) {
    const absPath = join(projectRoot, f.relPath);
    const sections = parseSections(absPath, f.content, projectRoot);
    allSections.push(...sections);

    const fm = parseFrontmatter(f.content).raw;
    const provenance = readProvenance(f.content);
    const mode = modeForFile(toPosix(f.relPath), fm);
    const tags = tagsForFile(fm);

    const dId = docId(f.relPath);
    addNode({
      id: dId,
      type: 'document',
      label: cleanUntrustedId(f.relPath),
      file: f.relPath,
      mode,
      status: provenance.status,
      reviewedHash: provenance.reviewedHash,
    });

    for (const tag of tags) {
      const tId = tagId(tag);
      addNode({ id: tId, type: 'tag', label: cleanUntrustedId(tag) });
      addEdge({ from: dId, to: tId, type: 'tag' });
    }

    const walkSection = (section: Section, parentId: string) => {
      const sId = ensureSectionNode(section.id, section.heading);
      const node = nodes.get(sId)!;
      node.file = f.relPath;
      addEdge({ from: parentId, to: sId, type: 'contains' });
      for (const child of section.children) {
        walkSection(child, sId);
      }
    };
    for (const root of sections) {
      walkSection(root, dId);
    }
  }

  const flat: Section[] = [];
  const flatten = (secs: Section[]) => {
    for (const s of secs) {
      flat.push(s);
      flatten(s.children);
    }
  };
  flatten(allSections);
  const sectionIds = new Set(flat.map((s) => s.id.toLowerCase()));
  const fileIndex = buildFileIndex(allSections);
  const slugIndex = buildSectionSlugIndex(allSections);

  // Wiki links: section -> section (or section -> code target).
  for (const f of sortedFiles) {
    const absPath = join(projectRoot, f.relPath);
    const refs = extractRefs(absPath, f.content, projectRoot);
    for (const ref of refs) {
      const { resolved, ambiguous } = resolveRef(
        ref.target,
        sectionIds,
        fileIndex,
        slugIndex,
      );
      const fromId = ensureSectionNode(ref.fromSection);
      if (!ambiguous && sectionIds.has(resolved.toLowerCase())) {
        const toId = ensureSectionNode(resolved);
        addEdge({ from: fromId, to: toId, type: 'wikilink' });
      } else {
        const cId = codeId(ref.target);
        addNode({
          id: cId,
          type: 'code',
          label: cleanUntrustedId(ref.target),
        });
        addEdge({ from: fromId, to: cId, type: 'wikilink' });
      }
    }
  }

  // Code refs (the `// @lat: [[section-id]]` comment marker) and test-spec coverage: code -> section.
  if (includeCode) {
    const scan = await scanCodeRefs(projectRoot);
    for (const ref of scan.refs) {
      const { resolved, ambiguous } = resolveRef(
        ref.target,
        sectionIds,
        fileIndex,
        slugIndex,
      );
      const label = `${ref.file}:${ref.line}`;
      const cId = codeId(label);
      addNode({ id: cId, type: 'code', label: cleanUntrustedId(label) });
      const toId =
        !ambiguous && sectionIds.has(resolved.toLowerCase())
          ? ensureSectionNode(resolved)
          : ensureSectionNode(ref.target);
      addEdge({ from: cId, to: toId, type: 'code-ref' });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** Read the working tree's lat.md files straight off disk. */
export async function loadWorkingTreeFiles(
  latticeDir: string,
  projectRoot: string,
): Promise<GraphSourceFile[]> {
  const { listLatticeFiles } = await import('./lattice.js');
  const { readFile } = await import('node:fs/promises');
  const paths = await listLatticeFiles(latticeDir);
  const files: GraphSourceFile[] = [];
  for (const p of paths) {
    const content = await readFile(p, 'utf-8');
    files.push({ relPath: toPosix(relative(projectRoot, p)), content });
  }
  return files;
}

/**
 * Reconstruct the lat.md/ markdown tree as it existed at a git revision.
 * Only the documents are reconstructed, not the surrounding source tree —
 * `buildGraph` is called with `includeCode: false` for these.
 */
export async function loadRevisionFiles(
  projectRoot: string,
  latticeDir: string,
  rev: string,
): Promise<GraphSourceFile[]> {
  const latRelDir = toPosix(relative(projectRoot, latticeDir));
  let lsOutput: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-tree', '-r', '--name-only', rev, '--', latRelDir],
      { cwd: projectRoot },
    );
    lsOutput = stdout;
  } catch (err) {
    throw new Error(
      `failed to list "${latRelDir}" at revision "${rev}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const paths = lsOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.md'));

  const files: GraphSourceFile[] = [];
  for (const p of paths) {
    const { stdout } = await execFileAsync('git', ['show', `${rev}:${p}`], {
      cwd: projectRoot,
    });
    files.push({ relPath: p, content: stdout });
  }
  return files;
}

export type GraphDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

/** Diff two graphs' section nodes by id, reporting added/removed/changed. */
export function diffGraphs(before: Graph, after: Graph): GraphDiff {
  const beforeSections = new Map(
    before.nodes.filter((n) => n.type === 'section').map((n) => [n.id, n]),
  );
  const afterSections = new Map(
    after.nodes.filter((n) => n.type === 'section').map((n) => [n.id, n]),
  );

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [id, node] of afterSections) {
    const prior = beforeSections.get(id);
    if (!prior) {
      added.push(id);
    } else if (prior.label !== node.label) {
      changed.push(id);
    }
  }
  for (const id of beforeSections.keys()) {
    if (!afterSections.has(id)) removed.push(id);
  }

  return { added, removed, changed };
}

// --- Formatters -----------------------------------------------------------

export function formatGraphJson(graph: Graph): string {
  return JSON.stringify(graph, null, 2);
}

const NODE_SHAPE: Record<GraphNodeType, [string, string]> = {
  document: ['([', '])'],
  section: ['[', ']'],
  code: ['[[', ']]'],
  tag: ['((', '))'],
};

function mermaidEscape(label: string): string {
  return label.replace(/"/g, '#quot;');
}

export function formatGraphMermaid(graph: Graph): string {
  const idMap = new Map<string, string>();
  graph.nodes.forEach((n, i) => idMap.set(n.id, `n${i}`));

  const lines: string[] = ['flowchart TD'];
  for (const node of graph.nodes) {
    const [open, close] = NODE_SHAPE[node.type];
    const label = mermaidEscape(`${node.type}: ${node.label}`);
    lines.push(`  ${idMap.get(node.id)}${open}"${label}"${close}`);
  }
  for (const edge of graph.edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue;
    lines.push(`  ${from} -->|${edge.type}| ${to}`);
  }
  return lines.join('\n');
}

function dotEscape(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function formatGraphDot(graph: Graph): string {
  const idMap = new Map<string, string>();
  graph.nodes.forEach((n, i) => idMap.set(n.id, `n${i}`));

  const lines: string[] = ['digraph lat {'];
  for (const node of graph.nodes) {
    const label = dotEscape(`${node.type}: ${node.label}`);
    lines.push(`  ${idMap.get(node.id)} [label="${label}"];`);
  }
  for (const edge of graph.edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue;
    lines.push(`  ${from} -> ${to} [label="${dotEscape(edge.type)}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

export type GraphFormat = 'json' | 'mermaid' | 'dot';

export function formatGraph(graph: Graph, format: GraphFormat): string {
  switch (format) {
    case 'mermaid':
      return formatGraphMermaid(graph);
    case 'dot':
      return formatGraphDot(graph);
    case 'json':
    default:
      return formatGraphJson(graph);
  }
}

export function formatGraphDiff(diff: GraphDiff): string {
  const lines: string[] = [];
  lines.push(`added (${diff.added.length}):`);
  for (const id of diff.added) lines.push(`  + ${cleanUntrustedId(id)}`);
  lines.push(`removed (${diff.removed.length}):`);
  for (const id of diff.removed) lines.push(`  - ${cleanUntrustedId(id)}`);
  lines.push(`changed (${diff.changed.length}):`);
  for (const id of diff.changed) lines.push(`  ~ ${cleanUntrustedId(id)}`);
  return lines.join('\n');
}
