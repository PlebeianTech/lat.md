import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { Heading, List, Paragraph, Root, RootContent } from 'mdast';
import { listLatticeFiles, parseFrontmatter } from '../lattice.js';
import { parse } from '../parser.js';
import { quoteUntrusted } from '../untrusted.js';
import { toPosix } from '../walk.js';
import type { CheckError } from './check.js';

export const DIATAXIS_MODES = [
  'tutorial',
  'how-to',
  'reference',
  'explanation',
] as const;
export type DiataxisMode = (typeof DIATAXIS_MODES)[number];

/** Directory below lat.md/ that holds each mode. */
export const MODE_DIRS: Record<DiataxisMode, string> = {
  tutorial: 'tutorials',
  'how-to': 'how-to',
  reference: 'reference',
  explanation: 'explanation',
};

/** Reverse lookup: first path segment -> mode. Built once, not per file. */
// Null-prototype: the key is a directory name read off disk.
const DIR_TO_MODE: Record<string, DiataxisMode> = Object.create(null);
for (const mode of DIATAXIS_MODES) {
  DIR_TO_MODE[MODE_DIRS[mode]] = mode;
}

const OUTCOME_RE =
  /\b(outcome|by the end|you will (build|learn|have|create)|what you (will )?(build|learn|have|create))\b/i;

/**
 * Imperative verbs that flag a command inside an explanation document.
 * Deliberately excludes ambiguous verbs (Use, Go, Make, Type, Enter, Call,
 * Import, Export) — each reads naturally as a noun or as descriptive prose
 * at the start of a sentence ("Use cases include...", "Type inference..."),
 * and including them produced false positives in testing.
 */
const IMPERATIVE_VERBS = [
  'Run',
  'Install',
  'Add',
  'Set',
  'Open',
  'Create',
  'Delete',
  'Edit',
  'Copy',
  'Move',
  'Click',
  'Press',
  'Configure',
  'Update',
  'Remove',
  'Execute',
  'Choose',
  'Select',
  'Replace',
  'Rename',
  'Restart',
  'Deploy',
];

const MAX_IMPERATIVE_ERRORS = 10;

function orderedListPresent(tree: Root): boolean {
  let found = false;
  const walk = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'list' && (node as List).ordered === true) {
        found = true;
        return;
      }
      if ('children' in node) {
        walk((node as { children: RootContent[] }).children);
      }
      if (found) return;
    }
  };
  walk(tree.children);
  return found;
}

function outcomeStated(tree: Root): boolean {
  for (const node of tree.children) {
    if (node.type === 'heading' || node.type === 'paragraph') {
      const text = inlineTextOf(node as Heading | Paragraph);
      if (OUTCOME_RE.test(text)) return true;
    }
  }
  return false;
}

function inlineTextOf(node: { children: RootContent[] }): string {
  return node.children
    .map((c) => {
      if ('value' in c && typeof c.value === 'string') return c.value;
      if ('children' in c)
        return inlineTextOf(c as { children: RootContent[] });
      return '';
    })
    .join('');
}

/**
 * A GFM table that the parser handed back as a paragraph.
 *
 * `src/parser.ts` runs remark without `remark-gfm`, so a pipe table is never a
 * `table` node — its rows arrive as one paragraph and every reference document
 * containing a table failed with "this is a second paragraph", while the error
 * text told the author to use a table. Adding the plugin would mean editing an
 * upstream file and changing what `remarkStringify` emits for the whole tool,
 * which `tests/roundtrip` pins; recognising the shape here costs nothing
 * outside this check.
 *
 * The signature is a delimiter row — `| --- | :--: |` — under a line that opens
 * a row. Both are required, because a delimiter row is what separates a table
 * from prose that merely contains pipes.
 */
function isPipeTable(node: Paragraph, lines: string[]): boolean {
  const start = node.position?.start.line;
  const end = node.position?.end.line;
  if (!start || !end || end - start < 1) return false;
  const rows = lines.slice(start - 1, end);
  return rows.some(
    (row, i) =>
      i > 0 &&
      /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(row) &&
      rows[i - 1].trimStart().startsWith('|'),
  );
}

/**
 * Extra top-level paragraphs found under headings, beyond the one
 * `checkSections` already permits as the leading summary. A paragraph
 * before the first heading is the document lead, not narrative prose.
 *
 * A pipe table is not prose and never counts, in either position: it is
 * neither the leading summary a reference is allowed nor an offender.
 */
function extraParagraphs(
  tree: Root,
  lines: string[],
): { line: number; heading: string }[] {
  const offenders: { line: number; heading: string }[] = [];
  let currentHeading: string | null = null;
  let seenParagraphUnderHeading = false;

  for (const node of tree.children) {
    if (node.type === 'heading') {
      currentHeading = inlineTextOf(node as Heading);
      seenParagraphUnderHeading = false;
      continue;
    }
    if (node.type === 'paragraph') {
      if (isPipeTable(node as Paragraph, lines)) continue;
      if (currentHeading === null) {
        // Document lead paragraph before any heading — allowed.
        continue;
      }
      if (!seenParagraphUnderHeading) {
        seenParagraphUnderHeading = true;
      } else {
        offenders.push({
          line: node.position!.start.line,
          heading: currentHeading,
        });
      }
    }
  }
  return offenders;
}

/**
 * Line numbers (1-indexed, inclusive of both ends) that belong to a `code`
 * or `yaml` (frontmatter) node anywhere in the tree. Walking the parsed tree
 * — rather than re-scanning raw text with a fence regex — means a fence of
 * any marker length or an indented code block is recognized correctly, and
 * frontmatter needs no special case: it simply isn't prose in the tree.
 */
function nonProseLines(tree: Root): Set<number> {
  const lines = new Set<number>();
  const markRange = (node: RootContent): void => {
    if (!node.position) return;
    for (
      let line = node.position.start.line;
      line <= node.position.end.line;
      line++
    ) {
      lines.add(line);
    }
  };
  const walk = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'code' || (node.type as string) === 'yaml') {
        markRange(node);
        continue;
      }
      if ('children' in node) {
        walk((node as { children: RootContent[] }).children);
      }
    }
  };
  walk(tree.children);
  return lines;
}

function findImperativeHits(
  tree: Root,
  content: string,
): { line: number; verb: string }[] {
  const hits: { line: number; verb: string }[] = [];
  const lines = content.split('\n');
  const skipLines = nonProseLines(tree);

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    if (skipLines.has(lineNumber)) continue;

    const trimmedStart = lines[i].trimStart();
    if (trimmedStart.startsWith('#')) continue;

    let text = trimmedStart;
    text = text.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '');
    text = text.replace(/^\*\*/, '');

    for (const verb of IMPERATIVE_VERBS) {
      if (text.startsWith(verb + ' ')) {
        hits.push({ line: lineNumber, verb });
        break;
      }
    }
  }
  return hits;
}

/**
 * The index file a directory is required to carry, e.g. `lat.md` for the root
 * and `reference.md` for `reference/`. An index is navigation rather than
 * content, so the `require-mode` gate below never asks one to declare a mode.
 */
export function indexNameFor(dirName: string): string {
  return dirName.endsWith('.md') ? dirName : dirName + '.md';
}

/**
 * What the root index says about the mode requirement.
 *
 * Opt-in, and deliberately read from the tree rather than from a flag or an
 * environment variable: the rule belongs to a documentation set, not to a
 * machine or a CI job, and a tree that predates the rule has to keep passing.
 * `lat init` stamps the flag into the root index it scaffolds, so a project
 * set up after this exists is gated from its first commit while an older one
 * is untouched until someone adds the line.
 *
 * The raw value is returned rather than a boolean so the caller can tell an
 * absent flag from one that was set to something this never reads. `yes` and
 * `1` are strings to a YAML 1.2 parser, and enforcing nothing on them while
 * saying nothing about them is how a project ends up believing the gate is on.
 */
async function readRequireModeFlag(latticeDir: string): Promise<unknown> {
  const indexPath = join(latticeDir, indexNameFor(basename(latticeDir)));
  try {
    const content = await readFile(indexPath, 'utf-8');
    return parseFrontmatter(content).raw['require-mode'];
  } catch {
    return undefined;
  }
}

export type CheckModeOptions = {
  /**
   * Enforce as if the root index said this, whatever it actually says. Used to
   * price adoption — running once each way and taking the difference is what
   * the offer in `lat init` reports, and it keeps that number defined by this
   * checker rather than by a second copy of its rules.
   */
  requireMode?: boolean;
};

export async function checkMode(
  latticeDir: string,
  projectRoot = dirname(latticeDir),
  options: CheckModeOptions = {},
): Promise<CheckError[]> {
  const files = await listLatticeFiles(latticeDir);
  const errors: CheckError[] = [];
  const flag = await readRequireModeFlag(latticeDir);
  const requireMode = options.requireMode ?? flag === true;

  if (flag !== undefined && typeof flag !== 'boolean') {
    const indexPath = join(latticeDir, indexNameFor(basename(latticeDir)));
    errors.push({
      file: relative(process.cwd(), indexPath),
      line: 1,
      target: toPosix(relative(projectRoot, indexPath)).replace(/\.md$/, ''),
      message: `require-mode is ${JSON.stringify(flag)} — it must be true or false.\n    Anything else is enforced as off, so the gate this line looks like it turns on is not running.`,
    });
  }

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const relPath = relative(process.cwd(), file);
    const target = toPosix(relative(projectRoot, file)).replace(/\.md$/, '');

    const fm = parseFrontmatter(content);
    const declaredRaw = fm.raw['mode'];
    // null (bare `mode:` key) is treated as absent; any other non-string is
    // reported below via declaredNonString.
    const declared =
      declaredRaw === null || declaredRaw === undefined
        ? undefined
        : typeof declaredRaw === 'string'
          ? declaredRaw
          : undefined;
    const declaredNonString =
      declaredRaw !== null &&
      declaredRaw !== undefined &&
      typeof declaredRaw !== 'string'
        ? declaredRaw
        : undefined;

    const relFromLattice = toPosix(relative(latticeDir, file));
    const firstSegment = relFromLattice.split('/')[0];
    const dirMode =
      firstSegment && firstSegment !== relFromLattice
        ? DIR_TO_MODE[firstSegment]
        : undefined;

    if (declaredNonString !== undefined) {
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `document declares unknown mode ${quoteUntrusted(JSON.stringify(declaredNonString), 40)} — use one of: tutorial, how-to, reference, explanation`,
      });
      continue;
    }

    if (
      declared !== undefined &&
      !(DIATAXIS_MODES as readonly string[]).includes(declared)
    ) {
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `document declares unknown mode ${quoteUntrusted(declared, 40)} — use one of: tutorial, how-to, reference, explanation`,
      });
      continue;
    }

    if (
      declared !== undefined &&
      dirMode !== undefined &&
      declared !== dirMode
    ) {
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `document is in lat.md/${firstSegment}/ but declares mode: ${declared} — the mode must match the directory that holds it`,
      });
      continue;
    }

    const mode = (declared ?? dirMode) as DiataxisMode | undefined;
    if (mode === undefined) {
      const segments = relFromLattice.split('/');
      const fileName = segments.pop()!;
      const holder =
        segments.length === 0 ? basename(latticeDir) : segments.at(-1)!;
      const isIndex = fileName === indexNameFor(holder);
      if (requireMode && !isIndex) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message:
            'document declares no Diátaxis mode and is not in a mode directory — move it under lat.md/tutorials/, lat.md/how-to/, lat.md/reference/ or lat.md/explanation/, or declare one under its `lat:` frontmatter.\n    A document that would fail its mode is usually two documents: the lookup half belongs in reference/, the reasoning half in explanation/.\n    (The root index sets require-mode: true. Remove that line to turn this off.)',
        });
      }
      continue;
    }

    const tree = parse(content);

    if (mode === 'how-to') {
      if (!orderedListPresent(tree)) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `a how-to must give ordered steps — add a numbered list`,
        });
      }
      continue;
    }

    if (mode === 'tutorial') {
      if (!orderedListPresent(tree)) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `a tutorial must give ordered steps — add a numbered list`,
        });
      }
      if (!outcomeStated(tree)) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `a tutorial must state its outcome — add a heading or sentence saying what the reader will have at the end`,
        });
      }
      continue;
    }

    if (mode === 'reference') {
      for (const offender of extraParagraphs(tree, content.split('\n'))) {
        errors.push({
          file: relPath,
          line: offender.line,
          target,
          message: `a reference must not contain narrative prose — this is a second paragraph under "${offender.heading}"; use a list, a table, or a code block instead`,
        });
      }
      continue;
    }

    if (mode === 'explanation') {
      const hits = findImperativeHits(tree, content);
      const capped = hits.slice(0, MAX_IMPERATIVE_ERRORS);
      for (const hit of capped) {
        errors.push({
          file: relPath,
          line: hit.line,
          target,
          message: `an explanation must not give commands — line starts with the imperative "${hit.verb}"; describe what happens instead, or move this to a how-to`,
        });
      }
      if (hits.length > MAX_IMPERATIVE_ERRORS) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `capped at ${MAX_IMPERATIVE_ERRORS} imperative-command errors for this document — fix these first, then re-run`,
        });
      }
    }
  }

  return errors;
}
