// External knowledge store adapter for codebase-memory-mcp (CBM). lat runs it
// with a JSON request on stdin and reads a JSON array of hits (operation
// 'query') or of callers (operation 'callers') from stdout. Any failure
// prints [] and exits 0: a store is optional, and this runs on the prompt
// path.
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
type CallersRequest = {
  operation: string;
  projectRoot: string;
  symbols: Array<{ file: string; name: string }>;
  depth: number;
};
type Caller = { file: string; name: string; line: number };

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

function joinQualifiedName(qnPrefix: string, name: string): string {
  return qnPrefix ? `${qnPrefix}.${name}` : name;
}

/**
 * The qualified name of a lat symbol, or undefined when CBM has no such node
 * in the symbol's file. `Greeter#greet` is the node `greet` whose qualified
 * name prefix ends in `Greeter`; a bare name is the node with the shortest
 * prefix, so a top-level function wins over a method of the same name.
 */
async function findQualifiedName(
  project: string,
  symbol: { file: string; name: string },
): Promise<string | undefined> {
  const symbolPath = symbol.name.split('#');
  const name = symbolPath.pop() as string;
  const className = symbolPath.pop();
  const { groups } = await runCbm('search_graph', [
    '--project',
    project,
    '--name-pattern',
    `^${escapeRegex(name)}$`,
    '--file-pattern',
    symbol.file,
  ]);
  const candidates = groups
    .filter(
      (group: any) =>
        group.file === symbol.file &&
        group.rows.some((row: string[]) => row[0] === name) &&
        (className === undefined ||
          group.qn_prefix.split('.').at(-1) === className),
    )
    .sort(
      (first: any, second: any) =>
        first.qn_prefix.length - second.qn_prefix.length,
    );
  if (candidates.length === 0) return undefined;
  return joinQualifiedName(candidates[0].qn_prefix, name);
}

/** The qualified names of the callers of `qualifiedName`, nearest first. */
async function traceCallerNames(
  project: string,
  qualifiedName: string,
  depth: number,
): Promise<string[]> {
  const { callers } = await runCbm('trace_path', [
    '--project',
    project,
    '--function-name',
    qualifiedName,
    '--direction',
    'inbound',
    '--depth',
    String(depth),
  ]);
  const callerNames = callers.groups.flatMap((group: any) =>
    group.rows.map(([name]: [string]) =>
      joinQualifiedName(group.qn_prefix, name),
    ),
  );
  return [...new Set<string>(callerNames)];
}

/**
 * Looks up where each qualified name lives. trace_path gives no file or
 * line, so one search_graph call finds them all. A method is named
 * `Class#method`, with the class taken from the qualified name.
 */
async function locateCallers(
  project: string,
  qualifiedNames: string[],
): Promise<Caller[]> {
  if (qualifiedNames.length === 0) return [];
  const { groups } = await runCbm('search_graph', [
    '--project',
    project,
    '--qn-pattern',
    `^(${qualifiedNames.map(escapeRegex).join('|')})$`,
    '--limit',
    String(qualifiedNames.length),
  ]);
  const callersByQualifiedName = new Map<string, Caller>();
  for (const group of groups) {
    for (const [name, label, lines] of group.rows) {
      const className = group.qn_prefix.split('.').at(-1);
      callersByQualifiedName.set(joinQualifiedName(group.qn_prefix, name), {
        file: group.file,
        name: label === 'Method' ? `${className}#${name}` : name,
        line: Number(String(lines).split('-')[0]),
      });
    }
  }
  return qualifiedNames.flatMap((qualifiedName) => {
    const caller = callersByQualifiedName.get(qualifiedName);
    return caller ? [caller] : [];
  });
}

async function callers(request: CallersRequest) {
  const project = await findProjectName(request.projectRoot);
  const answers = [];
  for (const symbol of request.symbols) {
    const qualifiedName = await findQualifiedName(project, symbol);
    if (qualifiedName === undefined) continue;
    const callerNames = await traceCallerNames(
      project,
      qualifiedName,
      request.depth,
    );
    answers.push({
      symbol,
      callers: await locateCallers(project, callerNames),
    });
  }
  return answers;
}

async function main(): Promise<void> {
  let answer: unknown[] = [];
  try {
    const request = JSON.parse(readFileSync(0, 'utf-8'));
    if (request.operation === 'query') answer = await query(request);
    if (request.operation === 'callers') answer = await callers(request);
  } catch {
    answer = [];
  }
  process.stdout.write(JSON.stringify(answer));
}

await main();
