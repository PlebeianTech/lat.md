// @lat: [[usage-findings-utilization#Usage Findings Utilization#A file edited in three sessions without coverage is reported]]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeQuery } from './aggregate-types.js';
import type { RawRecord } from './event-index.js';
import {
  groupedFinding,
  type Finding,
  type FindingDetector,
} from './findings.js';
import type { MissedKnowledge } from './missed-knowledge.js';

const execFileAsync = promisify(execFile);

/** Sessions in range that must edit an undocumented file to report it. */
export const HOT_FILE_MIN_SESSIONS = 3;

function missedKnowledgeOf(
  extension: unknown,
): Pick<MissedKnowledge, 'undocumented_files' | 'records'> {
  const analysis = extension as
    | (Partial<MissedKnowledge> & { error?: string })
    | undefined;
  if (analysis?.error !== undefined)
    throw new Error(`missed-knowledge analysis failed: ${analysis.error}`);
  return {
    undocumented_files: analysis?.undocumented_files ?? [],
    records: analysis?.records ?? [],
  };
}

/**
 * Whether a raw edit path names the project-root-relative `file`. Mirrors
 * relativeToRoot in missed-knowledge.ts, which strips a leading `./` and then
 * the git prefix of the project root; that function is private and the
 * prefix is not part of the analysis output.
 */
function namesFile(
  rawPath: string | null,
  file: string,
  prefix: string,
): boolean {
  if (rawPath === null || rawPath.startsWith('/')) return false;
  const clean = rawPath.replace(/^\.\//, '');
  return clean.startsWith(prefix) && clean.slice(prefix.length) === file;
}

/** Time of each session's first edit under the worktree, as the analysis takes it. */
function firstEditTimes(records: RawRecord[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const record of records) {
    if (
      record.type !== 'session' ||
      record.event.kind !== 'tool_call' ||
      record.event.tool.action !== 'edit' ||
      record.session_id === null ||
      record.event.tool.path === null ||
      record.event.tool.path.startsWith('/')
    )
      continue;
    const ts = Date.parse(record.ts);
    first.set(
      record.session_id,
      Math.min(first.get(record.session_id) ?? ts, ts),
    );
  }
  return first;
}

function uncoveredHotFiles(
  analysis: Pick<MissedKnowledge, 'undocumented_files'>,
  records: RawRecord[],
  days: string[],
  prefix: string,
): Finding[] {
  return analysis.undocumented_files
    .filter((file) => file.sessions >= HOT_FILE_MIN_SESSIONS)
    .map((file) =>
      groupedFinding(
        'uncovered-hot-file',
        file.path,
        records.filter(
          (record) =>
            record.type === 'session' &&
            record.event.kind === 'tool_call' &&
            record.event.tool.action === 'edit' &&
            namesFile(record.event.tool.path, file.path, prefix),
        ),
        days,
      ),
    );
}

function searchMisses(
  analysis: Pick<MissedKnowledge, 'records'>,
  records: RawRecord[],
  days: string[],
): Finding[] {
  const firstEdit = firstEditTimes(records);
  const missedSessions = new Map<string, Set<string>>();
  for (const outcome of analysis.records) {
    if (outcome.outcome !== 'searched-not-found') continue;
    for (const query of outcome.queries_before_first_edit ?? []) {
      const key = JSON.stringify([query, outcome.section_id]);
      const sessions = missedSessions.get(key) ?? new Set<string>();
      sessions.add(outcome.session_id);
      missedSessions.set(key, sessions);
    }
  }
  return [...missedSessions].map(([key, sessions]) => {
    const [query, sectionId] = JSON.parse(key) as [string, string];
    const finding = groupedFinding(
      'search-miss',
      query,
      records.filter(
        (record) =>
          record.type === 'usage' &&
          record.event.command === 'search' &&
          record.session_id !== null &&
          sessions.has(record.session_id) &&
          Date.parse(record.ts) <
            (firstEdit.get(record.session_id) ?? Infinity) &&
          record.event.query !== null &&
          normalizeQuery(record.event.query) === query,
      ),
      days,
    );
    return {
      ...finding,
      id: `${finding.id}|${sectionId}`,
      expected_section_id: sectionId,
    };
  });
}

/** Reads the project root's offset inside its git worktree. */
export type PrefixReader = (root: string) => Promise<string>;

const readGitPrefix: PrefixReader = async (root) =>
  (
    await execFileAsync('git', ['-C', root, 'rev-parse', '--show-prefix'])
  ).stdout.trim();

export function createUtilizationDetector(
  readPrefix: PrefixReader = readGitPrefix,
): FindingDetector {
  const prefixes = new Map<string, string>();
  let prefix = '';
  return {
    name: 'utilization',
    async prepare({ root }) {
      let known = prefixes.get(root);
      if (known === undefined) {
        // A missing prefix only narrows the matching, so a git failure is not an error.
        known = await readPrefix(root).catch(() => '');
        prefixes.set(root, known);
      }
      prefix = known;
    },
    detect({ summary, records }) {
      const analysis = missedKnowledgeOf(summary.extensions.missed_knowledge);
      return [
        ...uncoveredHotFiles(analysis, records, summary.days, prefix),
        ...searchMisses(analysis, records, summary.days),
      ];
    },
  };
}

export const utilizationDetector = createUtilizationDetector();
