// @lat: [[usage-findings-stale-sections#Usage Findings Stale Sections#A referenced file newer than its section is stale]]
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildGraph,
  loadWorkingTreeFiles,
  type GraphEdge,
} from '../../graph-export.js';
import { groupedFinding, type FindingDetector } from './findings.js';

const execFileAsync = promisify(execFile);

export const HOT_SECTION_LIMIT = 20;

/** Runs git with an argument array in `cwd` and returns its stdout. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const runGit: GitRunner = async (cwd, args) =>
  (await execFileAsync('git', ['-C', cwd, ...args])).stdout;

/** What one section depends on, by project-root-relative path. */
interface SectionFiles {
  markdown: string;
  referenced: Set<string>;
}

/**
 * Seconds since the epoch of each file's last commit, from one pass over the
 * history. The first sighting of a path is its latest commit; untracked
 * files are absent.
 */
async function lastCommitTimes(
  git: GitRunner,
  root: string,
): Promise<Map<string, number>> {
  const out = await git(root, [
    '-c',
    'core.quotepath=off',
    'log',
    '--name-only',
    '--relative',
    '--format=@%ct',
  ]);
  const times = new Map<string, number>();
  let time = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('@')) time = Number(line.slice(1));
    else if (line !== '' && !times.has(line)) times.set(line, time);
  }
  return times;
}

/** The file a graph edge endpoint names, or null when it names none. */
function referencedFile(edge: GraphEdge): string | null {
  if (edge.type === 'code-ref') {
    const label = edge.from.slice('code:'.length);
    return label.slice(0, label.lastIndexOf(':'));
  }
  if (edge.type === 'wikilink' && edge.role === 'symbol-ref')
    return edge.to.slice('code:'.length).split('#')[0];
  return null;
}

async function staleSectionIds(
  git: GitRunner,
  root: string,
): Promise<Set<string>> {
  const files = await loadWorkingTreeFiles(join(root, 'lat.md'), root);
  const graph = await buildGraph(files, root, true);
  const markdownOf = new Map<string, string>();
  for (const node of graph.nodes)
    if (node.type === 'section' && node.file)
      markdownOf.set(node.id, node.file);
  const sections = new Map<string, SectionFiles>();
  for (const edge of graph.edges) {
    const file = referencedFile(edge);
    const sectionNode = edge.type === 'code-ref' ? edge.to : edge.from;
    const markdown = markdownOf.get(sectionNode);
    if (!file || !markdown) continue;
    const entry = sections.get(sectionNode) ?? {
      markdown,
      referenced: new Set<string>(),
    };
    entry.referenced.add(file);
    sections.set(sectionNode, entry);
  }
  const times = await lastCommitTimes(git, root);
  const stale = new Set<string>();
  for (const [id, { markdown, referenced }] of sections) {
    const sectionTime = times.get(markdown);
    if (sectionTime === undefined) continue;
    for (const file of referenced) {
      const fileTime = times.get(file);
      if (fileTime !== undefined && fileTime > sectionTime) {
        const sectionId = id.slice('section:'.length);
        // Graph ids are relative to the project root; read events use ids
        // relative to the lat.md directory. Match either.
        stale.add(sectionId);
        stale.add(sectionId.replace(/^lat\.md\//, ''));
        break;
      }
    }
  }
  return stale;
}

export function createStaleHotSectionDetector(
  git: GitRunner = runGit,
): FindingDetector {
  let cachedHead: string | null = null;
  let stale = new Set<string>();
  return {
    name: 'stale-hot-section',
    async prepare({ root }) {
      const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
      const key = `${root}\0${head}`;
      if (key === cachedHead) return;
      stale = await staleSectionIds(git, root);
      cachedHead = key;
    },
    detect({ summary }) {
      return [...summary.sections]
        .filter((section) => section.reads > 0)
        .sort((a, b) => b.reads - a.reads || (a.key < b.key ? -1 : 1))
        .slice(0, HOT_SECTION_LIMIT)
        .filter((section) => stale.has(section.key))
        .map((section) => ({
          ...groupedFinding('stale-hot-section', section.key, [], summary.days),
          count: section.reads,
        }));
    },
  };
}

export const staleHotSectionDetector = createStaleHotSectionDetector();
