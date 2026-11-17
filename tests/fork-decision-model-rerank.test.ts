import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InvalidArgumentError } from 'commander';
import { plainStyler } from '@plebeiantech/lat.md-core/context';
import type {
  Section,
  SectionMatch,
} from '@plebeiantech/lat.md-core/lattice-model';
import {
  parseRerankUrl,
  rerankCandidateCount,
  rerankSearchMatches,
  RERANK_REQUEST_TIMEOUT_MILLISECONDS,
  RERANK_QUESTION_INSTRUCTIONS,
} from '../src/fork/decision-model-rerank.js';
import { searchCommand } from '../src/cli/search.js';
import { prepareSearchQuery } from '../src/search/search.js';
import type { Embedder } from '@lat.md/embed';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmDirBestEffort } from './util.js';

const rerankUrl = 'http://127.0.0.1:9/v1/decide';

let projectRoot: string;

function makeMatch(heading: string, line: number): SectionMatch {
  const section: Section = {
    id: `lat.md/notes#Notes#${heading}`,
    heading,
    depth: 2,
    file: 'lat.md/notes',
    filePath: 'lat.md/notes.md',
    children: [],
    startLine: line,
    endLine: line + 1,
    firstParagraph: `${heading} body.`,
  };
  return {
    section,
    reason: 'hybrid match',
    rankScore: 0.5,
    diagnostics: {
      lexicalCapped: false,
      semanticCapped: false,
      lexicalCandidates: 1,
      semanticCandidates: 1,
    },
  };
}

const alpha = () => makeMatch('Alpha', 3);
const beta = () => makeMatch('Beta', 6);
const gamma = () => makeMatch('Gamma', 9);

function answer(probability: unknown): Response {
  return new Response(
    JSON.stringify({ answers: { relevant: { noul: probability } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function headingsOf(matches: SectionMatch[]): string[] {
  return matches.map((match) => match.section.heading);
}

let warnings: string[];

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'lat-rerank-'));
  mkdirSync(join(projectRoot, 'lat.md'));
  writeFileSync(
    join(projectRoot, 'lat.md', 'notes.md'),
    [
      '# Notes',
      '',
      '## Alpha',
      'Alpha body.',
      '',
      '## Beta',
      'Beta body.',
      '',
      '## Gamma',
      'Gamma body.',
      '',
    ].join('\n'),
  );
  warnings = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    warnings.push(String(chunk));
    return true;
  });
  vi.stubEnv('LAT_RERANK_MODEL', undefined);
  vi.stubEnv('LAT_RERANK_KEY', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmDirBestEffort(projectRoot);
});

describe('decision model rerank', () => {
  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Orders matches by the returned probability]]
  it('orders matches by the returned probability', async () => {
    const probabilities = [0.1, 0.9, 0.5];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer(probabilities.shift())),
    );
    const matches = await rerankSearchMatches(
      projectRoot,
      'question',
      [alpha(), beta(), gamma()],
      3,
      rerankUrl,
    );
    expect(headingsOf(matches)).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(matches[0].diagnostics).toMatchObject({ rerankProbability: 0.9 });
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Ties keep search order]]
  it('keeps search order between equal probabilities', async () => {
    const probabilities = [0.4, 0.4, 0.8];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer(probabilities.shift())),
    );
    const matches = await rerankSearchMatches(
      projectRoot,
      'question',
      [alpha(), beta(), gamma()],
      3,
      rerankUrl,
    );
    expect(headingsOf(matches)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Retrieves at least ten candidates and returns the limit]]
  it('retrieves at least ten candidates and returns the limit', async () => {
    expect(rerankCandidateCount(5, rerankUrl)).toBe(10);
    expect(rerankCandidateCount(12, rerankUrl)).toBe(12);
    const fetchMock = vi.fn(async () => answer(0.5));
    vi.stubGlobal('fetch', fetchMock);
    const matches = await rerankSearchMatches(
      projectRoot,
      'question',
      [alpha(), beta(), gamma()],
      2,
      rerankUrl,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(headingsOf(matches)).toEqual(['Alpha', 'Beta']);
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#A limit below one keeps the limit error]]
  it('passes a limit below one through to the limit error', async () => {
    for (const limit of [0, -1]) {
      const candidateCount = rerankCandidateCount(limit, rerankUrl);
      expect(candidateCount).toBe(limit);
      await expect(
        prepareSearchQuery('question', {} as Embedder, candidateCount),
      ).rejects.toThrow('limit must be a positive integer');
    }
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Sends the request body the decision model expects]]
  it('sends the exact request body, model and bearer header', async () => {
    vi.stubEnv('LAT_RERANK_MODEL', 'judge');
    vi.stubEnv('LAT_RERANK_KEY', 'secret');
    const fetchMock = vi.fn(async (..._args: unknown[]) => answer(0.5));
    vi.stubGlobal('fetch', fetchMock);
    await rerankSearchMatches(
      projectRoot,
      'where is beta?',
      [beta()],
      5,
      rerankUrl,
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(rerankUrl);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'judge',
      state: {
        question: 'where is beta?',
        section: 'Notes > Beta\n\nBeta body.',
      },
      questions: {
        relevant: { type: 'noul', instructions: RERANK_QUESTION_INSTRUCTIONS },
      },
    });
  });

  it('uses the default model and no authorization without the variables', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => answer(0.5));
    vi.stubGlobal('fetch', fetchMock);
    await rerankSearchMatches(projectRoot, 'q', [beta()], 5, rerankUrl);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string).model).toBe('default');
  });

  it('caps the section text at 1,200 characters', async () => {
    writeFileSync(
      join(projectRoot, 'lat.md', 'notes.md'),
      ['# Notes', '', '## Alpha', 'x'.repeat(5000), ''].join('\n'),
    );
    const fetchMock = vi.fn(async (..._args: unknown[]) => answer(0.5));
    vi.stubGlobal('fetch', fetchMock);
    const long = alpha();
    long.section.endLine = 4;
    await rerankSearchMatches(projectRoot, 'q', [long], 5, rerankUrl);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const section: string = JSON.parse(init.body as string).state.section;
    expect(section).toBe('Notes > Alpha\n\n' + 'x'.repeat(1200));
  });

  describe('falls back to search order with one warning', () => {
    async function expectFallback() {
      const matches = await rerankSearchMatches(
        projectRoot,
        'question',
        [alpha(), beta(), gamma()],
        2,
        rerankUrl,
      );
      expect(headingsOf(matches)).toEqual(['Alpha', 'Beta']);
      expect(matches[0].diagnostics).not.toHaveProperty('rerankProbability');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/search order/);
    }

    // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Falls back to search order when the decision model fails]]
    it('on a network error', async () => {
      const fetchMock = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      vi.stubGlobal('fetch', fetchMock);
      await expectFallback();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('on an HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('busy', { status: 503 })),
      );
      await expectFallback();
    });

    it('on a malformed response', async () => {
      const responses = [answer(0.7), answer('yes')];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => responses.shift() ?? answer(0.1)),
      );
      await expectFallback();
    });

    it('on a probability outside 0 to 1', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => answer(1.5)),
      );
      await expectFallback();
    });

    it('on a redirect, without following it', async () => {
      const server = createServer((request, response) => {
        if (request.url === '/decide') {
          response.writeHead(307, { Location: '/moved' });
          response.end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ answers: { relevant: { noul: 0.9 } } }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;
      try {
        const matches = await rerankSearchMatches(
          projectRoot,
          'question',
          [alpha(), beta(), gamma()],
          2,
          `http://127.0.0.1:${port}/decide`,
        );
        expect(headingsOf(matches)).toEqual(['Alpha', 'Beta']);
        expect(matches[0].diagnostics).not.toHaveProperty('rerankProbability');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/search order/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('on a timeout, without waiting in real time', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const pending = expectFallback();
      while (fetchMock.mock.calls.length === 0)
        await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(RERANK_REQUEST_TIMEOUT_MILLISECONDS);
      await pending;
      expect(warnings[0]).toMatch(/timed out/);
    });
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Rejects a value that is not an HTTP URL]]
  it('rejects a value that is not an http or https URL', () => {
    expect(parseRerankUrl('https://example.test/decide')).toBe(
      'https://example.test/decide',
    );
    expect(parseRerankUrl(rerankUrl)).toBe(rerankUrl);
    expect(() => parseRerankUrl('localhost:8888')).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseRerankUrl('not a url')).toThrow(InvalidArgumentError);
    expect(() => parseRerankUrl('ftp://example.test/')).toThrow(
      InvalidArgumentError,
    );
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Rejects a URL with a user name or password]]
  it('rejects a URL with a user name or password', () => {
    for (const url of [
      'https://user@example.test/decide',
      'https://user:secret@example.test/decide',
      'https://:secret@example.test/decide',
    ])
      expect(() => parseRerankUrl(url)).toThrow(/LAT_RERANK_KEY/);
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Never prints a key that cannot go in a header]]
  it('never prints a key that cannot go in a header', async () => {
    const key = 'secret-part-one\nsecret-part-two';
    vi.stubEnv('LAT_RERANK_KEY', key);
    const fetchMock = vi.fn(async () => answer(0.5));
    vi.stubGlobal('fetch', fetchMock);

    const matches = await rerankSearchMatches(
      projectRoot,
      'question',
      [alpha(), beta()],
      2,
      rerankUrl,
    );

    expect(headingsOf(matches)).toEqual(['Alpha', 'Beta']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/search order/);
    expect(warnings[0]).not.toContain('secret-part');
  });

  // @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#Leaves search unchanged without the flag]]
  it('leaves search unchanged without the flag', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const original = [alpha(), beta(), gamma()];
    expect(rerankCandidateCount(5, undefined)).toBe(5);
    const matches = await rerankSearchMatches(
      projectRoot,
      'question',
      original,
      5,
      undefined,
    );
    expect(matches).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

// @lat: [[tests/fork-decision-model-rerank#Fork Decision Model Rerank#The search command applies the reranker]]
describe('lat search with --rerank', () => {
  it('prints the decision model order, and the plain order without the flag', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'lat-rerank-cmd-'));
    cpSync(join(import.meta.dirname, 'cases', 'rag'), fixtureRoot, {
      recursive: true,
    });
    vi.stubEnv('LAT_LLM_KEY', '');
    vi.stubEnv('LAT_LLM_KEY_FILE', '');
    vi.stubEnv('LAT_LLM_KEY_HELPER', '');
    vi.stubEnv('XDG_CONFIG_HOME', join(fixtureRoot, '.config'));
    const ctx = {
      latDir: join(fixtureRoot, 'lat.md'),
      projectRoot: fixtureRoot,
      styler: plainStyler,
      mode: 'cli' as const,
    };
    const resultIds = (output: string) =>
      [...output.matchAll(/Section: \[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    try {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const section: string = JSON.parse(init.body as string).state.section;
        return answer(
          section.startsWith('Architecture > Deployment') ? 0.9 : 0.1,
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const plain = await searchCommand(ctx, 'how do we handle user login?', {
        limit: 2,
        minSimilarity: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const plainIds = resultIds(plain.output);
      expect(plainIds).toHaveLength(2);
      expect(plainIds[0]).not.toContain('Deployment');

      const reranked = await searchCommand(
        ctx,
        'how do we handle user login?',
        { limit: 2, minSimilarity: 0, debug: true, rerank: rerankUrl },
      );
      expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
      const rerankedIds = resultIds(reranked.output);
      expect(rerankedIds).toHaveLength(2);
      expect(rerankedIds[0]).toContain('Architecture#Deployment');
      expect(rerankedIds[1]).toBe(plainIds[0]);
      expect(reranked.output).toContain('"rerankProbability":0.9');
    } finally {
      rmDirBestEffort(fixtureRoot);
    }
  }, 120_000);
});
