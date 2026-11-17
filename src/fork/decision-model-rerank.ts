import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidArgumentError } from 'commander';
import type { SectionMatch } from '@plebeiantech/lat.md-core/lattice-model';

export const RERANK_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
export const RERANK_MINIMUM_CANDIDATE_COUNT = 10;
export const RERANK_SECTION_TEXT_MAXIMUM_CHARACTERS = 1_200;
export const RERANK_DEFAULT_MODEL = 'default';
export const RERANK_QUESTION_INSTRUCTIONS =
  'The question is what a reader wants to find in the project documentation. Does this documentation section directly answer the question?';

// @lat: [[decision-model-rerank#Decision Model Rerank#The flag]]
export function parseRerankUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError('rerank must be an http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new InvalidArgumentError('rerank must be an http or https URL');
  if (url.username || url.password)
    throw new InvalidArgumentError(
      'rerank URL must not contain a user name or password; put the key in LAT_RERANK_KEY',
    );
  return value;
}

// @lat: [[decision-model-rerank#Decision Model Rerank#Candidates and order]]
export function rerankCandidateCount(
  limit: number,
  rerankUrl: string | undefined,
): number {
  if (!rerankUrl || limit < 1) return limit;
  return Math.max(limit, RERANK_MINIMUM_CANDIDATE_COUNT);
}

// @lat: [[decision-model-rerank#Decision Model Rerank#When the decision model fails]]
export async function rerankSearchMatches(
  projectRoot: string,
  query: string,
  matches: SectionMatch[],
  limit: number,
  rerankUrl: string | undefined,
): Promise<SectionMatch[]> {
  if (!rerankUrl) return matches;

  const probabilities: number[] = [];
  try {
    const fileLines = new Map<string, string[]>();
    for (const match of matches) {
      const section = await sectionText(projectRoot, match, fileLines);
      probabilities.push(await askDecisionModel(rerankUrl, query, section));
    }
  } catch (error) {
    process.stderr.write(
      `The rerank decision model failed (${(error as Error).message}), so these results keep the search order.\n`,
    );
    return matches.slice(0, limit);
  }

  return matches
    .map((match, searchPosition) => ({
      match,
      searchPosition,
      probability: probabilities[searchPosition],
    }))
    .sort(
      (left, right) =>
        right.probability - left.probability ||
        left.searchPosition - right.searchPosition,
    )
    .slice(0, limit)
    .map(({ match, probability }) => ({
      ...match,
      diagnostics: match.diagnostics && {
        ...match.diagnostics,
        rerankProbability: probability,
      },
    }));
}

async function sectionText(
  projectRoot: string,
  match: SectionMatch,
  fileLines: Map<string, string[]>,
): Promise<string> {
  const { section } = match;
  let lines = fileLines.get(section.filePath);
  if (!lines) {
    const content = await readFile(
      join(projectRoot, section.filePath),
      'utf-8',
    );
    lines = content.split('\n');
    fileLines.set(section.filePath, lines);
  }
  const headingPath = section.id.split('#').slice(1).join(' > ');
  const body = lines
    .slice(section.startLine, section.endLine)
    .join('\n')
    .trim()
    .slice(0, RERANK_SECTION_TEXT_MAXIMUM_CHARACTERS);
  return `${headingPath}\n\n${body}`;
}

// @lat: [[decision-model-rerank#Decision Model Rerank#The request]]
async function askDecisionModel(
  rerankUrl: string,
  question: string,
  section: string,
): Promise<number> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = process.env.LAT_RERANK_KEY;
  if (apiKey && /[^\x21-\x7E]/.test(apiKey))
    throw new Error(
      'LAT_RERANK_KEY has a character that cannot go in an HTTP header',
    );
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('the request timed out')),
    RERANK_REQUEST_TIMEOUT_MILLISECONDS,
  );
  try {
    const response = await fetch(rerankUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: process.env.LAT_RERANK_MODEL || RERANK_DEFAULT_MODEL,
        state: { question, section },
        questions: {
          relevant: {
            type: 'noul',
            instructions: RERANK_QUESTION_INSTRUCTIONS,
          },
        },
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      answers?: { relevant?: { noul?: unknown } };
    };
    const probability = body?.answers?.relevant?.noul;
    if (
      typeof probability !== 'number' ||
      !(probability >= 0 && probability <= 1)
    )
      throw new Error('the response has no probability from 0 to 1');
    return probability;
  } finally {
    clearTimeout(timer);
  }
}
