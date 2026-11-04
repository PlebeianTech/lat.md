import { Buffer } from 'node:buffer';
import { join, relative } from 'node:path';
import type { CmdContext } from '@plebeiantech/lat.md-core/context';
import type {
  Section,
  SectionMatch,
} from '@plebeiantech/lat.md-core/lattice-model';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import {
  cleanUntrusted,
  cleanUntrustedId,
} from '@plebeiantech/lat.md-core/untrusted';
import {
  getSection,
  formatSectionOutput,
} from '@plebeiantech/lat.md-core/cli/section';

export const PROMPT_SEARCH_MAX_BYTES = 2500;

export const NAVIGATION_HINT =
  'Run lat section "section#id" to read the full content of a matching section.';

export function truncateToUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) {
    end--;
  }
  if (end > 0) {
    const lead = buf[end - 1];
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    if (end - 1 + seqLen > maxBytes) {
      end = end - 1;
    } else {
      end = end - 1 + seqLen;
    }
  }
  return buf.subarray(0, end).toString('utf-8');
}

export function formatCompactSearchMatch(
  ctx: CmdContext,
  section: Section,
): string {
  const id = cleanUntrustedId(section.id);
  const rawRelPath = toPosix(
    relative(process.cwd(), join(ctx.projectRoot, section.filePath)),
  );
  const relPath = cleanUntrustedId(rawRelPath);
  const loc = `${relPath}:${section.startLine}-${section.endLine}`;

  const rawSummary = section.firstParagraph?.trim() ?? '';
  if (!rawSummary) {
    return `* [[${id}]] (${loc})`;
  }

  const cleanSummary = cleanUntrusted(rawSummary, 300);
  if (!cleanSummary) {
    return `* [[${id}]] (${loc})`;
  }

  return `* [[${id}]] (${loc}) - ${cleanSummary}`;
}

// @lat: [[cli#CLI#hook#UserPromptSubmit]]
export async function formatPromptSearchMatches(
  ctx: CmdContext,
  matches: readonly SectionMatch[],
  maxBytes: number = PROMPT_SEARCH_MAX_BYTES,
): Promise<string | null> {
  if (matches.length === 0) return null;

  const header = `Search results for the user prompt (${matches.length} matches):`;

  if (matches.length === 1) {
    try {
      const sectionResult = await getSection(ctx, matches[0].section.id);
      if (sectionResult.kind === 'found') {
        const fullOutput = formatSectionOutput(ctx, sectionResult);
        const combined = `${header}\n\n${fullOutput}`;
        if (Buffer.byteLength(combined, 'utf-8') <= maxBytes) {
          return combined;
        }
      }
    } catch {
      // Fall through to compact preview
    }
  }

  const previewLines: string[] = [];
  for (const match of matches) {
    const line = formatCompactSearchMatch(ctx, match.section);
    const candidateParts = [
      header,
      '',
      ...previewLines,
      line,
      '',
      NAVIGATION_HINT,
    ];
    const candidateText = candidateParts.join('\n');
    if (Buffer.byteLength(candidateText, 'utf-8') <= maxBytes) {
      previewLines.push(line);
    } else {
      break;
    }
  }

  const parts = [header, ''];
  if (previewLines.length > 0) {
    parts.push(...previewLines, '');
  }
  parts.push(NAVIGATION_HINT);

  const result = parts.join('\n');
  if (Buffer.byteLength(result, 'utf-8') > maxBytes) {
    return truncateToUtf8Bytes(result, maxBytes);
  }
  return result;
}
