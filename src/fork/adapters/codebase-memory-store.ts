// External knowledge store adapter for codebase-memory-mcp (CBM). lat runs it
// with a JSON request on stdin and reads a JSON array of hits from stdout.
// Any failure prints [] and exits 0: a store is optional, and this runs on
// the prompt path.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Hit = { key: string; title: string; detail: string; score: number };
type QueryRequest = {
  operation: string;
  terms: string[];
  projectRoot: string;
  limit: number;
};
type CodeSymbol = { qualifiedName: string; detail: string };

/** Runs one CBM tool and returns its parsed JSON output. */
async function runCbm(tool: string, flags: string[]): Promise<any> {
  const { stdout } = await execFileAsync('codebase-memory-mcp', [
    'cli',
    tool,
    ...flags,
    '--format',
    'json',
  ]);
  return JSON.parse(stdout);
}

async function findProjectName(projectRoot: string): Promise<string> {
  const { projects } = await runCbm('list_projects', []);
  const project = projects.find(
    (candidate: { root_path: string }) =>
      resolve(candidate.root_path) === resolve(projectRoot),
  );
  if (!project) throw new Error('project is not indexed');
  return project.name;
}

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The symbols whose name matches `term`. CBM prints them in groups that share
 * a file and a qualified-name prefix; each row is [name, label, "start-end"].
 */
async function searchSymbols(
  project: string,
  term: string,
): Promise<CodeSymbol[]> {
  const { groups } = await runCbm('search_graph', [
    '--project',
    project,
    '--name-pattern',
    escapeRegex(term),
  ]);
  return groups.flatMap((group: any) =>
    group.rows.map(([name, , lines]: [string, string, string]) => {
      const startLine = String(lines).split('-')[0];
      return {
        qualifiedName: group.qn_prefix ? `${group.qn_prefix}.${name}` : name,
        detail: startLine ? `${group.file}:${startLine}` : group.file,
      };
    }),
  );
}

async function query(request: QueryRequest): Promise<Hit[]> {
  const project = await findProjectName(request.projectRoot);
  const hits = new Map<string, Hit>();
  for (const term of request.terms) {
    const matched = new Set<string>();
    for (const symbol of await searchSymbols(project, term)) {
      if (matched.has(symbol.qualifiedName)) continue;
      matched.add(symbol.qualifiedName);
      const hit = hits.get(symbol.qualifiedName) ?? {
        key: symbol.qualifiedName,
        title: symbol.qualifiedName,
        detail: symbol.detail,
        score: 0,
      };
      hit.score += 1;
      hits.set(symbol.qualifiedName, hit);
    }
  }
  return [...hits.values()]
    .sort((first, second) => second.score - first.score)
    .slice(0, request.limit);
}

async function main(): Promise<void> {
  let hits: Hit[] = [];
  try {
    const request: QueryRequest = JSON.parse(readFileSync(0, 'utf-8'));
    if (request.operation === 'query') hits = await query(request);
  } catch {
    hits = [];
  }
  process.stdout.write(JSON.stringify(hits));
}

await main();
