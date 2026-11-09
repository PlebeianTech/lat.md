import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { CmdContext, CmdResult } from '@plebeiantech/lat.md-core/context';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import { handleResult } from '@plebeiantech/lat.md-core/cli';
import { resolveContext } from '@plebeiantech/lat.md-core/cli/context';
import { commandProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import {
  findSections,
  flattenSections,
  type Section,
} from '@plebeiantech/lat.md-core/lattice-model';
import { parseFrontmatter } from '@plebeiantech/lat.md-core/lattice';
import { resolveSourceSymbol } from '@plebeiantech/lat.md-core/source-parser';
import {
  buildGraph,
  loadWorkingTreeFiles,
  type GraphEdge,
  type GraphSourceFile,
} from '../graph-export.js';

const DEFAULT_DEPTH = 2;
const SECTION_NODE_PREFIX = 'section:';
const CODE_NODE_PREFIX = 'code:';
const SUGGESTION_LIMIT = 5;
// The bytes `lat section` costs for cli#search#Backend selection; the default
// unreferenced listing stays under it.
const OUTPUT_BUDGET_BYTES = 4119;

export type ImpactOptions = {
  depth?: string;
  specs?: boolean;
  unreferenced?: boolean;
  all?: boolean;
};

// @lat: [[cli#impact]]
export type ImpactIndex = {
  sections: Section[];
  sectionsById: Map<string, Section>;
  edges: GraphEdge[];
  referrersByNode: Map<string, string[]>;
  /** Project-relative paths of the documents buildGraph treats as test specs. */
  testSpecFiles: Set<string>;
};

export function deriveReferrers(edges: GraphEdge[]): Map<string, string[]> {
  const referrersByNode = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'wikilink' && edge.type !== 'code-ref') continue;
    if (edge.from === edge.to) continue;
    const referrers = referrersByNode.get(edge.to) ?? [];
    referrers.push(edge.from);
    referrersByNode.set(edge.to, referrers);
  }
  return referrersByNode;
}

export function buildImpactIndex(
  sections: Section[],
  edges: GraphEdge[],
  testSpecFiles: Set<string>,
): ImpactIndex {
  return {
    sections,
    sectionsById: new Map(
      flattenSections(sections).map((s) => [s.id.toLowerCase(), s]),
    ),
    edges,
    referrersByNode: deriveReferrers(edges),
    testSpecFiles,
  };
}

// Mirrors buildGraph's private test-spec rule, which graph-export.ts does not export.
function findTestSpecFiles(files: GraphSourceFile[]): Set<string> {
  const specs = new Set<string>();
  for (const file of files) {
    const posixPath = toPosix(file.relPath);
    const { raw, requireCodeMention } = parseFrontmatter(file.content);
    if (
      requireCodeMention === true ||
      raw['require-code-mention'] === true ||
      posixPath.startsWith('lat.md/tests/') ||
      posixPath.startsWith('lat.md/knowledge/tests/')
    ) {
      specs.add(file.relPath);
    }
  }
  return specs;
}

export async function loadImpactIndex(ctx: CmdContext): Promise<ImpactIndex> {
  const { allSections } = await commandProjectAnalysis(ctx);
  const files = await loadWorkingTreeFiles(ctx.latDir, ctx.projectRoot);
  const graph = await buildGraph(files, ctx.projectRoot, true);
  return buildImpactIndex(allSections, graph.edges, findTestSpecFiles(files));
}

export function resolveSection(
  index: ImpactIndex,
  query: string,
): { section: Section } | { suggestions: Section[] } {
  const matches = findSections(
    index.sections,
    query.replace(/^\[\[|\]\]$/g, ''),
  );
  const top = matches[0];
  const isConfident =
    top !== undefined &&
    (top.reason === 'exact match' ||
      top.reason.startsWith('file stem expanded') ||
      top.reason === 'section name match');
  if (isConfident) return { section: top.section };
  return { suggestions: matches.map((m) => m.section) };
}

type Reached = { section: Section; distance: number };

// Breadth-first, backwards. `frontier` nodes sit at `firstDistance - 1`, so
// their referrers are reported at `firstDistance`. Code nodes are walked
// through but never reported.
function walkBackwards(
  index: ImpactIndex,
  seen: Set<string>,
  frontier: string[],
  firstDistance: number,
): Reached[] {
  const reached: Reached[] = [];
  for (let distance = firstDistance; frontier.length > 0; distance++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const referrer of index.referrersByNode.get(node) ?? []) {
        if (seen.has(referrer)) continue;
        seen.add(referrer);
        next.push(referrer);
        const section = sectionOfNode(index, referrer);
        if (section !== undefined) reached.push({ section, distance });
      }
    }
    frontier = next;
  }
  return reached;
}

function sectionOfNode(index: ImpactIndex, node: string): Section | undefined {
  if (!node.startsWith(SECTION_NODE_PREFIX)) return undefined;
  return index.sectionsById.get(
    node.slice(SECTION_NODE_PREFIX.length).toLowerCase(),
  );
}

export function walkReferrers(index: ImpactIndex, start: Section): Reached[] {
  const startNode = `${SECTION_NODE_PREFIX}${start.id}`;
  return walkBackwards(index, new Set([startNode]), [startNode], 1);
}

function formatResult(section: Section): string {
  return `  ${section.id}  ${section.filePath}:${section.startLine}`;
}

function formatTail(distances: number[], depth: number): string {
  const first = depth + 1;
  const last = Math.max(...distances);
  const range = first === last ? `${first}` : `${first}-${last}`;
  return `${distances.length} more at depth ${range} (--depth ${last} lists them)`;
}

export function reportImpact(
  index: ImpactIndex,
  query: string,
  opts: { depth: number },
): CmdResult {
  const resolved = resolveSection(index, query);
  if (!('section' in resolved)) {
    const hints = resolved.suggestions
      .slice(0, SUGGESTION_LIMIT)
      .map((s) => `  ${s.id}`);
    const didYouMean = hints.length > 0 ? ['Did you mean:', ...hints] : [];
    return {
      output: [`error: no section matches "${query}"`, ...didYouMean].join(
        '\n',
      ),
      isError: true,
    };
  }

  const target = resolved.section;
  const reached = walkReferrers(index, target);
  if (reached.length === 0) {
    return { output: `No section depends on ${target.id}.` };
  }

  return {
    output: formatReached(
      reached,
      `${reached.length} section${reached.length === 1 ? '' : 's'} affected by ${target.id}`,
      opts.depth,
    ),
  };
}

function formatReached(
  reached: Reached[],
  header: string,
  depth: number,
): string {
  const hidden = reached.filter((r) => r.distance > depth);
  const lines = [header];
  const byDistance = new Map<number, Section[]>();
  for (const r of reached) {
    const sections = byDistance.get(r.distance);
    if (sections) sections.push(r.section);
    else byDistance.set(r.distance, [r.section]);
  }
  const deepest = Math.max(...byDistance.keys());
  for (let distance = 1; distance <= Math.min(depth, deepest); distance++) {
    const atDistance = byDistance.get(distance) ?? [];
    if (atDistance.length === 0) continue;
    lines.push('', `depth ${distance} (${atDistance.length}):`);
    lines.push(...atDistance.map(formatResult));
  }
  if (hidden.length > 0) {
    lines.push(
      '',
      formatTail(
        hidden.map((r) => r.distance),
        depth,
      ),
    );
  }
  return lines.join('\n');
}

// Which `#` lines continue a comment block depends on the language. In
// Python, Ruby and PHP `#` starts a comment. In Rust only an attribute such as
// `#[derive(Debug)]` sits between a doc comment and its item. Everywhere
// else `#` is code: a C or Swift directive, or a JS private field.
const HASH_COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/;
const RUST_COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#!?\[)/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const HASH_COMMENT_FILE = /\.(py|rb|rake|erb|php)$/;

function commentLineFor(file: string): RegExp {
  if (HASH_COMMENT_FILE.test(file)) return HASH_COMMENT_LINE;
  if (file.endsWith('.rs')) return RUST_COMMENT_LINE;
  return COMMENT_LINE;
}

// The comment block directly above a declaration documents it: consecutive
// comment lines with no blank or code line between them and the declaration.
async function firstLineOfSymbolBlock(
  projectRoot: string,
  file: string,
  startLine: number,
): Promise<number> {
  const lines = (await readFile(join(projectRoot, file), 'utf-8')).split('\n');
  const commentLine = commentLineFor(file);
  let first = startLine;
  while (first > 1 && commentLine.test(lines[first - 2])) first--;
  return first;
}

// A symbol is covered at distance 1 by the sections that link to it and by the
// sections that `@lat` comments inside its line range, or in the comment
// block directly above it, point at. graph-export
// keys a comment as code:<file>:<line> but a symbol link as code:<file>#<symbol>,
// so the two never coincide and the join is the file and line range.
function directSpecTargets(
  index: ImpactIndex,
  file: string,
  symbolNode: string,
  range: { startLine: number; endLine: number },
): string[] {
  const commentPrefix = `${CODE_NODE_PREFIX}${file}:`;
  const linkedSections = index.referrersByNode.get(symbolNode) ?? [];
  const commentedSections = index.edges
    .filter((edge) => {
      if (edge.type !== 'code-ref' || !edge.from.startsWith(commentPrefix)) {
        return false;
      }
      const line = Number(edge.from.slice(commentPrefix.length));
      return line >= range.startLine && line <= range.endLine;
    })
    .map((edge) => edge.to);
  return [...linkedSections, ...commentedSections];
}

export async function reportSpecCoverage(
  index: ImpactIndex,
  projectRoot: string,
  query: string,
  opts: { depth: number },
): Promise<CmdResult> {
  const [file, ...symbolParts] = query.split('#');
  const symbolPath = symbolParts.join('#');
  const { found, symbols } =
    symbolPath === ''
      ? { found: false, symbols: [] }
      : await resolveSourceSymbol(file, symbolPath, projectRoot);
  const [parent, name] =
    symbolParts.length === 2 ? symbolParts : [undefined, symbolPath];
  const symbol = found
    ? symbols.find((s) => s.name === name && s.parent === parent)
    : undefined;
  if (symbol === undefined) {
    return {
      output: `error: no symbol matches "${query}" (expected <file>#<symbol>)`,
      isError: true,
    };
  }

  const symbolNode = `${CODE_NODE_PREFIX}${query}`;
  const seen = new Set<string>([symbolNode]);
  const direct: Reached[] = [];
  const frontier: string[] = [];
  const range = {
    startLine: await firstLineOfSymbolBlock(
      projectRoot,
      file,
      symbol.startLine,
    ),
    endLine: symbol.endLine,
  };
  for (const node of directSpecTargets(index, file, symbolNode, range)) {
    if (seen.has(node)) continue;
    seen.add(node);
    frontier.push(node);
    const section = sectionOfNode(index, node);
    if (section !== undefined) direct.push({ section, distance: 1 });
  }
  const reached = [
    ...direct,
    ...walkBackwards(index, seen, frontier, 2),
  ].filter((r) => index.testSpecFiles.has(r.section.filePath));

  if (reached.length === 0) {
    return { output: `No test spec covers ${query}.` };
  }
  const header = `${reached.length} test spec${reached.length === 1 ? '' : 's'} covering ${query}`;
  return { output: formatReached(reached, header, opts.depth) };
}

export function reportUnreferenced(
  index: ImpactIndex,
  opts: { all: boolean },
): CmdResult {
  const unreferenced = flattenSections(index.sections).filter(
    (s) => !index.referrersByNode.has(`${SECTION_NODE_PREFIX}${s.id}`),
  );
  if (unreferenced.length === 0) {
    return { output: 'Every section is referenced.' };
  }
  const header = `${unreferenced.length} unreferenced section${unreferenced.length === 1 ? '' : 's'}`;
  const lines = unreferenced.map(formatResult);
  if (opts.all) return { output: [header, '', ...lines].join('\n') };

  const tail = (hidden: number) =>
    `${hidden} more unreferenced (--all lists them)`;
  let shown = lines.length;
  const render = () =>
    [
      header,
      '',
      ...lines.slice(0, shown),
      ...(shown < lines.length ? ['', tail(lines.length - shown)] : []),
    ].join('\n');
  while (shown > 0 && Buffer.byteLength(render()) >= OUTPUT_BUDGET_BYTES) {
    shown--;
  }
  return { output: render() };
}

function parseDepth(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_DEPTH;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

export async function impactCommand(
  ctx: CmdContext,
  query: string | undefined,
  opts: ImpactOptions,
): Promise<CmdResult> {
  const depth = parseDepth(opts.depth);
  if (depth === null) {
    return {
      output: `error: --depth must be a positive integer, got "${opts.depth}"`,
      isError: true,
    };
  }
  if (opts.unreferenced !== true && query === undefined) {
    return {
      output:
        'error: a section argument is required unless --unreferenced is given',
      isError: true,
    };
  }
  const index = await loadImpactIndex(ctx);
  if (opts.unreferenced === true) {
    return reportUnreferenced(index, { all: opts.all === true });
  }
  if (query === undefined) throw new Error('unreachable: query checked above');
  if (opts.specs === true) {
    return reportSpecCoverage(index, ctx.projectRoot, query, { depth });
  }
  return reportImpact(index, query, { depth });
}

export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description(
      'List the sections affected if a section changes (ids and file:line only)',
    )
    .argument(
      '[section]',
      'section id to analyse (with --specs: <file>#<symbol>; not used with --unreferenced)',
    )
    .option(
      '--depth <n>',
      `how many hops of referrers to list (default ${DEFAULT_DEPTH})`,
    )
    .option(
      '--specs',
      'list the test specs that cover a code symbol (<file>#<symbol>) through the @lat chain; same output budget and depth',
    )
    .option(
      '--unreferenced',
      'list the sections nothing refers to, as ids and file:line; default output is bounded',
    )
    .option('--all', 'with --unreferenced, print every section')
    .action(async (query: string | undefined, opts: ImpactOptions) => {
      const ctx = resolveContext(program.opts());
      handleResult(await impactCommand(ctx, query, opts));
    });
}
