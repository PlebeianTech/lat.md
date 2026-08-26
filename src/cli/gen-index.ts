import { readFile } from 'node:fs/promises';
import { cleanUntrusted } from '../untrusted.js';
import { isLatticeLocalDest } from './link-scheme.js';

// Mirrors the two escaping rules in hooks/generate_docs_index.rb (see
// lat-t1y.5). Both were found by a working exploit against that generator,
// and the same exploit applies here: an index entry's title is repository
// text (an H1 heading or a leading paragraph) placed into a generated
// Markdown link, so it must be treated as untrusted the moment it is quoted.

/**
 * Escape a link LABEL. Without this, a title of `Real](https://evil/)
 * [ignore` closes the generated link early and reopens it against an
 * attacker's URL, leaving the real target as the label of a second,
 * harmless-looking link. Backslash-escaping is CommonMark's own answer: each
 * of these renders as the literal character.
 */
const MD_LABEL_SPECIALS = /([\\[\]()`])/g;

export function mdEscapeLabel(value: string): string {
  return value.replace(MD_LABEL_SPECIALS, '\\$1');
}

/**
 * Escape a link DESTINATION. A destination does not escape the same way a
 * label does: a `)` anywhere ends the destination there, and CommonMark reads
 * a bare `\` in a destination as an escape for the punctuation after it.
 * Percent-encoding survives the round trip; backslash-escaping does not,
 * because a renderer that decodes `%5C` back to `\` does not then treat it as
 * an escape character again.
 *
 * `%` itself must be in the class too, or the encoding is not injective: a
 * file genuinely named `a%28b.md` would be emitted verbatim and then decoded
 * by the renderer to `a(b.md` — a link to a path that does not exist.
 */
const MD_DEST_SPECIALS = /[()<>\s%\\]/g;

export function mdEscapeDest(value: string): string {
  return value.replace(
    MD_DEST_SPECIALS,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

export type IndexEntrySource = {
  /** Filesystem entry name: "notes.md" for a file, "guides" for a directory. */
  name: string;
  /**
   * Link destination relative to the index file being written: the child's
   * own filename ("notes.md"), or its own index file for a directory
   * ("guides/guides.md"). This is what actually resolves on disk — unlike
   * the wiki-link stem, it keeps the .md extension.
   */
  dest: string;
  /** Absolute path to read the title/summary from (the file itself, or a directory's own index file). */
  readFrom: string;
};

function fallbackTitle(name: string): string {
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name;
  return stem.replace(/[-_]/g, ' ');
}

/**
 * Pull a title (first `# ` heading) and a summary (the paragraph that
 * follows it, or the document's own leading paragraph when it has no
 * heading) out of a document's raw text. Deliberately simple line scanning
 * rather than a full parse — good enough for index generation, and it avoids
 * depending on parseSections' heading-to-id machinery here.
 */
async function titleAndSummary(
  readFrom: string,
  fallback: string,
): Promise<{ title: string; summary: string }> {
  let content: string;
  try {
    content = await readFile(readFrom, 'utf-8');
  } catch {
    return { title: fallback, summary: '(no summary yet)' };
  }

  const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = stripped.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === '') idx++;

  let title = fallback;
  if (idx < lines.length && /^#\s+\S/.test(lines[idx])) {
    title = lines[idx].replace(/^#\s+/, '').trim();
    idx++;
  }
  while (idx < lines.length && lines[idx].trim() === '') idx++;

  const paraLines: string[] = [];
  while (
    idx < lines.length &&
    lines[idx].trim() !== '' &&
    !/^#{1,6}\s/.test(lines[idx]) &&
    !/^- /.test(lines[idx])
  ) {
    paraLines.push(lines[idx]);
    idx++;
  }

  const summary = paraLines.join(' ').trim();
  return {
    title: cleanUntrusted(title || fallback, 120),
    summary: summary ? cleanUntrusted(summary, 300) : '(no summary yet)',
  };
}

/**
 * Render the generated bullet list for a directory index, one entry per
 * child, sorted by title. Each entry links through the wiki-link stem
 * (`entryToStem`-compatible) using a real Markdown link so the title can
 * carry a human-written summary — which is exactly why it must be escaped:
 * the title is repository text landing inside `[...]`.
 */
export async function renderIndexEntries(
  entries: IndexEntrySource[],
): Promise<string> {
  const rendered = await Promise.all(
    entries.map(async (entry) => {
      const { title, summary } = await titleAndSummary(
        entry.readFrom,
        fallbackTitle(entry.name),
      );
      return {
        title,
        line: `- [${mdEscapeLabel(title)}](${mdEscapeDest(entry.dest)}) — ${mdEscapeLabel(summary)}`,
      };
    }),
  );

  rendered.sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
  );
  return rendered.map((r) => r.line).join('\n');
}

/** HTML comment markers delimiting the region `--fix` is allowed to rewrite. */
const BEGIN_MARKER = '<!-- lat:index:begin -->';
const END_MARKER = '<!-- lat:index:end -->';

// Tolerant of a trailing \r so a CRLF file's marker lines still match —
// `existingContent` is otherwise split on plain '\n' (see the module doc).
const BEGIN_RE = /^<!-- lat:index:begin -->\r?$/;
const END_RE = /^<!-- lat:index:end -->\r?$/;

/**
 * True when `line` is a "local index entry bullet" per the shared predicate
 * documented in link-scheme.ts: the legacy wiki form, or a Markdown link
 * bullet whose destination names a child of this directory. This MUST agree
 * with `parseIndexEntries` in check.ts — both read the same bullets, and a
 * second, differently-behaved copy of the rule is exactly how they drift.
 */
function isIndexEntryBulletLine(line: string): boolean {
  const trimmed = line.replace(/\r$/, '');
  if (/^- \[\[/.test(trimmed)) return true;
  const m = /^- \[(?:\\.|[^\]])*\]\(([^)]*)\)/.exec(trimmed);
  if (!m) return false;
  return isLatticeLocalDest(m[1]);
}

/** A fenced code block delimiter line (opening or closing ``` or ~~~). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Compute, for each line, whether it lies inside a fenced code block.
 * Marker and bullet-run detection must skip fenced lines — otherwise a
 * documentation example that shows the marker syntax (or a sample bullet
 * list) inside a ``` block gets mistaken for the real thing and rewritten.
 */
export function fencedLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const isFenceDelim = FENCE_RE.test(lines[i].replace(/\r$/, ''));
    if (isFenceDelim) {
      // The delimiter line itself counts as "inside" so it can never be
      // mistaken for a marker or entry bullet either.
      mask[i] = true;
      inFence = !inFence;
    } else {
      mask[i] = inFence;
    }
  }
  return mask;
}

export type SpliceResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

/**
 * Splice a freshly rendered entry list into an index file's content inside
 * `<!-- lat:index:begin -->` / `<!-- lat:index:end -->` markers, preserving
 * everything outside that region byte for byte. An unmarked file is
 * migrated by wrapping the first contiguous run of local index entry
 * bullets; a malformed marker pair is refused rather than guessed at.
 */
export function spliceIndexContent(
  existingContent: string | null,
  dirLabel: string,
  renderedList: string,
): SpliceResult {
  const block = `${BEGIN_MARKER}\n${renderedList}\n${END_MARKER}`;

  if (existingContent === null) {
    return { ok: true, content: `${dirLabel} directory index.\n\n${block}\n` };
  }

  const lines = existingContent.replace(/\n$/, '').split('\n');
  const fenced = fencedLineMask(lines);
  const beginIdx = lines.findIndex((l, i) => !fenced[i] && BEGIN_RE.test(l));
  // The end marker that matters is the first one AFTER begin (per the
  // design contract). Fall back to the first end anywhere so an end marker
  // with no begin at all is still detected and reported.
  let endIdx = -1;
  if (beginIdx !== -1) {
    for (let i = beginIdx + 1; i < lines.length; i++) {
      if (!fenced[i] && END_RE.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
  } else {
    endIdx = lines.findIndex((l, i) => !fenced[i] && END_RE.test(l));
  }

  if (beginIdx !== -1 || endIdx !== -1) {
    if (beginIdx === -1) {
      return {
        ok: false,
        message:
          'found a "lat:index:end" marker with no matching "lat:index:begin" marker — fix the markers by hand before running --fix again',
      };
    }
    if (endIdx === -1) {
      return {
        ok: false,
        message:
          'found a "lat:index:begin" marker with no matching "lat:index:end" marker — fix the markers by hand before running --fix again',
      };
    }
    if (endIdx < beginIdx) {
      return {
        ok: false,
        message:
          'found a "lat:index:end" marker before the "lat:index:begin" marker — fix the markers by hand before running --fix again',
      };
    }

    const before = lines.slice(0, beginIdx);
    const after = lines.slice(endIdx + 1);
    const rebuilt = [...before, block, ...after].join('\n');
    return { ok: true, content: `${rebuilt}\n` };
  }

  // No markers at all: migrate. Find the first contiguous run of local index
  // entry bullets and replace exactly that run with the marked block.
  let runStart = -1;
  let runEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!fenced[i] && isIndexEntryBulletLine(lines[i])) {
      if (runStart === -1) runStart = i;
      runEnd = i;
    } else if (runStart !== -1) {
      break;
    }
  }

  if (runStart !== -1) {
    const before = lines.slice(0, runStart);
    const after = lines.slice(runEnd + 1);
    const rebuilt = [...before, block, ...after].join('\n');
    return { ok: true, content: `${rebuilt}\n` };
  }

  // No entry-bullet run: insert before the first heading, or append at the end.
  const headingIdx = lines.findIndex(
    (l, i) => !fenced[i] && /^#{2,6}\s/.test(l),
  );
  if (headingIdx !== -1) {
    const before = lines.slice(0, headingIdx);
    while (before.length > 0 && before[before.length - 1].trim() === '') {
      before.pop();
    }
    const after = lines.slice(headingIdx);
    const rebuilt = [...before, '', block, '', ...after].join('\n');
    return { ok: true, content: `${rebuilt}\n` };
  }

  const trimmedExisting = lines.join('\n').replace(/\s+$/, '');
  const rebuilt =
    trimmedExisting.length > 0 ? `${trimmedExisting}\n\n${block}` : block;
  return { ok: true, content: `${rebuilt}\n` };
}
