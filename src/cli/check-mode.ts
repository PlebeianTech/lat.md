import { readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
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
 * Extra top-level paragraphs found under headings, beyond the one
 * `checkSections` already permits as the leading summary. A paragraph
 * before the first heading is the document lead, not narrative prose.
 */
function extraParagraphs(tree: Root): { line: number; heading: string }[] {
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

export async function checkMode(
  latticeDir: string,
  projectRoot = dirname(latticeDir),
): Promise<CheckError[]> {
  const files = await listLatticeFiles(latticeDir);
  const errors: CheckError[] = [];

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
    if (mode === undefined) continue;

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
      for (const offender of extraParagraphs(tree)) {
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
