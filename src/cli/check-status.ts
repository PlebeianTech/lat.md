import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { listLatticeFiles, parseFrontmatter } from '../lattice.js';
import { toPosix } from '../walk.js';
import { quoteUntrusted } from '../untrusted.js';
import type { Styler } from '../context.js';
import type { CheckError } from './check.js';
import { fencedLineMask } from './gen-index.js';

/**
 * Who wrote a document, and whether a person has checked it.
 *
 * lat.md states that agents write the graph. Without this field an unmarked
 * claim written by an agent reaches the model carrying exactly the authority
 * of one a person read and approved.
 */
export const DOC_STATUSES = ['human-reviewed', 'agent-extracted'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

/**
 * The shortest `reviewed-hash` prefix that is accepted as a match. A full
 * SHA-256 is 64 hex characters and unpleasant to keep in frontmatter, so an
 * author may record an abbreviated form. Eight characters is 32 bits — far
 * past accidental collision for the handful of revisions one document sees,
 * and this value is a staleness signal, not a security boundary.
 */
const MIN_HASH_PREFIX = 8;

const HEX = /^[0-9a-f]+$/i;

export type DocProvenance = {
  /** Raw `status` value, which may not be one this build understands. */
  status?: string;
  /** Raw `reviewed-hash` value, which may not be hex. */
  reviewedHash?: string;
};

/**
 * Read the provenance fields out of a document's frontmatter.
 *
 * Fields live under the top-level `lat:` mapping, so they are read off
 * `LatFrontmatter.raw` rather than being promoted to named fields. Adding a
 * named field would mean editing `parseFrontmatter`, and keeping that function
 * closed to per-feature edits is the whole reason `raw` exists.
 */
export function readProvenance(content: string): DocProvenance {
  const raw = parseFrontmatter(content).raw;
  const result: DocProvenance = {};
  const status = raw['status'];
  if (typeof status === 'string') result.status = status;
  const hash = raw['reviewed-hash'];
  if (typeof hash === 'string') result.reviewedHash = hash;
  else if (typeof hash === 'number') result.reviewedHash = String(hash);
  return result;
}

/**
 * Hash the prose a review actually covered.
 *
 * A plain `status` field becomes a lie the moment an agent edits the document:
 * the field still says a person checked the text, but the text is no longer
 * the text that person read. Capturing the content at review time turns that
 * silent failure into a check.
 *
 * Frontmatter is excluded deliberately: adding an unrelated frontmatter key
 * does not change a single claim in the prose, and invalidating a review for
 * it would train authors to re-stamp the hash without re-reading — which
 * costs the field its meaning.
 *
 * Heading TEXT is excluded for the same reason — re-titling a section changes
 * no claim in the prose. But a heading LINE is not: adding or removing a
 * heading changes the document's structure (a new section exists that no one
 * has reviewed), and that must flip the hash even though no non-heading line
 * changed. So each heading line is reduced to its `#` marker (which carries
 * its level and position) rather than dropped outright — retitling a section
 * leaves the marker alone, but appending or removing a heading changes the
 * sequence of markers and therefore the hash. (Swapping two headings of the
 * same level produces the same marker sequence and is not detected — a
 * narrower version of the blind spot this fix closes.)
 */
export function hashReviewedBody(content: string): string {
  // Normalize line endings BEFORE stripping frontmatter: the delimiter regex
  // is written with bare \n, so on a CRLF-saved document it would not match
  // and the whole frontmatter block — reviewed-hash included — would be
  // hashed as body, making every such review spuriously stale.
  const normalized = content.replace(/\r\n/g, '\n');
  const withoutFrontmatter = normalized.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = withoutFrontmatter.split('\n');
  // A `#`-prefixed line inside a fenced code block is a shell comment, not a
  // heading. Collapsing it would hand an editor a free, unhashed rewrite slot
  // in every fenced example. The same mask the index reader and writer share.
  const fenced = fencedLineMask(lines);
  const body = lines
    .map((line, i) => {
      if (fenced[i]) return line;
      const heading = /^(#{1,6})\s/.exec(line);
      return heading ? heading[1] : line;
    })
    // Trailing whitespace is invisible in a diff and must not flip a review.
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
  return createHash('sha256').update(body, 'utf-8').digest('hex');
}

function hashMatches(recorded: string, actual: string): boolean {
  const want = recorded.trim().toLowerCase();
  if (want.length < MIN_HASH_PREFIX || !HEX.test(want)) return false;
  return actual.startsWith(want);
}

export type ProvenanceNote = {
  kind: 'unreviewed' | 'stale' | 'reviewed';
  text: string;
};

/**
 * The one-line provenance annotation for `lat section` and `lat search`, or
 * null when the document says nothing about its provenance.
 *
 * A document with no `status` produces nothing at all. Most documents in most
 * repositories have no status, and a line on every one of them would be noise
 * that readers learn to skip — which would cost the warning its force on the
 * documents that do carry one.
 */
export function provenanceNote(content: string): ProvenanceNote | null {
  const { status, reviewedHash } = readProvenance(content);
  if (status === undefined) return null;

  if (status === 'agent-extracted') {
    return {
      kind: 'unreviewed',
      text: '[unreviewed -- written by an agent, not checked by a person]',
    };
  }

  if (status === 'human-reviewed') {
    // No hash means an older tree that predates the field. Saying nothing is
    // deliberate: an upgrade must not repaint an existing graph with warnings.
    if (reviewedHash === undefined) {
      return { kind: 'reviewed', text: '[human-reviewed]' };
    }
    if (hashMatches(reviewedHash, hashReviewedBody(content))) {
      return { kind: 'reviewed', text: '[human-reviewed]' };
    }
    return {
      kind: 'stale',
      text: '[stale review -- the text changed after a person checked it]',
    };
  }

  // An unknown value is repository text and is quoted as such. `lat check
  // status` reports it; the reader is told only that it means nothing here.
  return {
    kind: 'unreviewed',
    text: `[unrecognized status ${quoteUntrusted(status, 40)} -- treat as unreviewed]`,
  };
}

/** Colourize a note for terminal output. */
export function formatProvenanceNote(note: ProvenanceNote, s: Styler): string {
  if (note.kind === 'reviewed') return s.green(note.text);
  return s.yellow(note.text);
}

/**
 * Report documents whose recorded review no longer describes their text.
 *
 * This is a static validation. It needs no history and no database, and it
 * catches most of what a temporal graph would answer.
 */
export async function checkStatus(
  latticeDir: string,
  projectRoot = dirname(latticeDir),
): Promise<CheckError[]> {
  const files = await listLatticeFiles(latticeDir);
  const errors: CheckError[] = [];

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const relPath = relative(process.cwd(), file);
    const target = toPosix(relative(projectRoot, file)).replace(/\.md$/, '');
    const { status, reviewedHash } = readProvenance(content);

    if (status === undefined) {
      if (reviewedHash !== undefined) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `document records a reviewed-hash but no status — add "status: human-reviewed", or drop the hash`,
        });
      }
      continue;
    }

    if (!(DOC_STATUSES as readonly string[]).includes(status)) {
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `document declares unknown status ${quoteUntrusted(status, 40)} — use one of: human-reviewed, agent-extracted`,
      });
      continue;
    }

    if (status === 'agent-extracted') {
      if (reviewedHash !== undefined) {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `document is agent-extracted but records a reviewed-hash — a hash records that a person checked the text, so set "status: human-reviewed" or drop the hash`,
        });
      }
      continue;
    }

    // human-reviewed. No hash is not an error: existing trees must not turn
    // red on upgrade. It simply buys no staleness detection.
    if (reviewedHash === undefined) continue;

    const actual = hashReviewedBody(content);
    const recorded = reviewedHash.trim().toLowerCase();

    if (!HEX.test(recorded) || recorded.length < MIN_HASH_PREFIX) {
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `reviewed-hash must be at least ${MIN_HASH_PREFIX} hex characters — record "reviewed-hash: ${actual}"`,
      });
      continue;
    }

    if (!actual.startsWith(recorded)) {
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `stale review — the text changed after it was reviewed. Re-read it, then record "reviewed-hash: ${actual}"`,
      });
    }
  }

  return errors;
}
