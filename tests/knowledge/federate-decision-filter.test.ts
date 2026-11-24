import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirBestEffort } from '../util.js';
import { federateTags } from '../../src/knowledge/index.js';
import type {
  KnowledgeHit,
  Store,
  TaggedDoc,
} from '../../src/knowledge/types.js';

const providerScript = join(__dirname, '../fixtures/callers-provider.cjs');
const prompt = 'Fix the login redirect bug';
const dirsToClean: string[] = [];
const serversToClose: Server[] = [];

type DecisionRequest = {
  state: { question: string; section: string };
  questions: { relevant: { instructions: string } };
};

/**
 * A local decision model. It records each request body and answers with the
 * probability `score` gives for the request's hit text, after `delayMs`.
 */
async function decisionServer(
  score: (section: string) => number,
  { status = 200, delayMs = 0 } = {},
): Promise<{ url: string; requests: DecisionRequest[] }> {
  const requests: DecisionRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const parsed = JSON.parse(body) as DecisionRequest;
      requests.push(parsed);
      setTimeout(() => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            answers: { relevant: { noul: score(parsed.state.section) } },
          }),
        );
      }, delayMs);
    });
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/decide`, requests };
}

/** Scores a hit 0.1 when its text mentions "noise", else 0.9. */
const dropNoise = (section: string) => (section.includes('noise') ? 0.1 : 0.9);

function storeWithTitles(byDoc: Record<string, string[]>): Store {
  return {
    name: 'bd',
    async query({ terms }): Promise<KnowledgeHit[]> {
      return (byDoc[terms[0]] ?? []).map((title, i) => ({
        store: 'bd',
        key: title,
        title,
        detail: `${title} detail`,
        score: 10 - i,
      }));
    },
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-federate-filter-'));
  dirsToClean.push(dir);
  return dir;
}

function hitLines(output: string | null): string[] {
  return (output ?? '').split('\n').filter((line) => line.startsWith('- '));
}

const doc: TaggedDoc = { id: 'lat.md/doc.md', tags: ['alpha'] };
let projectRoot: string;

beforeEach(() => {
  projectRoot = tempDir();
  vi.stubEnv('LAT_RERANK_KEY', undefined);
  vi.stubEnv('LAT_RERANK_MODEL', undefined);
  vi.stubEnv('LAT_FEDERATION_RERANK_URL', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of serversToClose.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

describe('federateTags decision filter', () => {
  // @lat: [[fork-federate-decision-filter#Hits scored below one half are dropped in order]]
  it('drops hits scored below 0.5 and keeps the order of the rest', async () => {
    const { url } = await decisionServer(dropNoise);
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const output = await federateTags([doc], {
      projectRoot,
      stores: [storeWithTitles({ alpha: ['first', 'noise', 'third'] })],
      prompt,
    });
    expect(hitLines(output)).toEqual([
      '- "first" -> "first detail"',
      '- "third" -> "third detail"',
    ]);
  });

  // @lat: [[fork-federate-decision-filter#Each request carries the prompt and the hit text]]
  it('sends the prompt, cut at 1,200 characters, and the hit text', async () => {
    const { url, requests } = await decisionServer(() => 0.9);
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const longPrompt = `${prompt} ${'x'.repeat(1300)}`;
    await federateTags([doc], {
      projectRoot,
      stores: [storeWithTitles({ alpha: ['first'] })],
      prompt: longPrompt,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].state.question).toBe(longPrompt.slice(0, 1200));
    expect(requests[0].state.section).toContain('bd memories:');
    expect(requests[0].state.section).toContain('first');
    expect(requests[0].state.section).toContain('first detail');
    expect(requests[0].questions.relevant.instructions).toMatch(
      /what the user asked a coding agent to do/,
    );
  });

  // @lat: [[fork-federate-decision-filter#A failing model keeps every hit]]
  it('keeps every hit when the model answers HTTP 500', async () => {
    const stores = [storeWithTitles({ alpha: ['first', 'noise'] })];
    const unfiltered = await federateTags([doc], { projectRoot, stores });
    const { url, requests } = await decisionServer(dropNoise, { status: 500 });
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const writes = [
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const output = await federateTags([doc], { projectRoot, stores, prompt });
    expect(requests.length).toBeGreaterThan(0);
    expect(output).toBe(unfiltered);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  // @lat: [[fork-federate-decision-filter#Nothing is sent after the deadline]]
  it('sends nothing and keeps every hit once the deadline has passed', async () => {
    const titles = ['first', 'noise'];
    const unfiltered = await federateTags([doc], {
      projectRoot,
      stores: [storeWithTitles({ alpha: titles })],
    });
    const { url, requests } = await decisionServer(dropNoise);
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const realNow = Date.now;
    let skewMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    const emitWarning = vi.spyOn(process, 'emitWarning');
    const lateStore: Store = {
      name: 'bd',
      async query(request) {
        const hits = await storeWithTitles({ alpha: titles }).query(request);
        skewMs = 10_000;
        return hits;
      },
    };
    const output = await federateTags([doc], {
      projectRoot,
      stores: [lateStore],
      prompt,
    });
    expect(requests).toHaveLength(0);
    expect(output).toBe(unfiltered);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  // @lat: [[fork-federate-decision-filter#Nothing is sent without a prompt and a valid URL]]
  it('sends nothing without the variable, a prompt, or a valid URL', async () => {
    const stores = [storeWithTitles({ alpha: ['first', 'noise'] })];
    const unfiltered = await federateTags([doc], { projectRoot, stores });
    const { url, requests } = await decisionServer(dropNoise);

    const withoutVariable = await federateTags([doc], {
      projectRoot,
      stores,
      prompt,
    });
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const withoutPrompt = await federateTags([doc], { projectRoot, stores });
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', 'ftp://127.0.0.1/decide');
    const withInvalidUrl = await federateTags([doc], {
      projectRoot,
      stores,
      prompt,
    });

    expect(requests).toHaveLength(0);
    expect(withoutVariable).toBe(unfiltered);
    expect(withoutPrompt).toBe(unfiltered);
    expect(withInvalidUrl).toBe(unfiltered);
  });

  // @lat: [[fork-federate-decision-filter#A document emptied by the filter is attempted empty]]
  it('marks a document whose hits are all dropped as attempted empty', async () => {
    const { url } = await decisionServer(dropNoise);
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const seen = new Set<string>();
    const attemptedEmpty = new Set<string>();
    const output = await federateTags([doc], {
      projectRoot,
      stores: [storeWithTitles({ alpha: ['noise one', 'noise two'] })],
      prompt,
      seen,
      attemptedEmpty,
    });
    expect(output).toBeNull();
    expect(attemptedEmpty.has(doc.id)).toBe(true);
    expect(seen.has(doc.id)).toBe(false);
  });

  // @lat: [[fork-federate-decision-filter#Requests run in parallel]]
  it('finishes five slow requests in about the time of one', async () => {
    const delayMs = 400;
    const { url, requests } = await decisionServer(() => 0.9, { delayMs });
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const started = Date.now();
    const output = await federateTags([doc], {
      projectRoot,
      stores: [storeWithTitles({ alpha: ['a', 'b', 'c', 'd', 'e'] })],
      perStoreLimit: 5,
      prompt,
    });
    expect(requests).toHaveLength(5);
    expect(hitLines(output)).toHaveLength(5);
    expect(Date.now() - started).toBeLessThan(delayMs * 2.5);
  });

  // @lat: [[fork-federate-decision-filter#Caller lines are never sent to the model]]
  it('never sends caller lines to the model', async () => {
    mkdirSync(join(projectRoot, 'lat.md'));
    writeFileSync(
      join(projectRoot, 'lat.md', 'doc.md'),
      '# Doc\n\nSee [[src/a.ts#foo]].\n',
    );
    const configHome = tempDir();
    mkdirSync(join(configHome, 'lat'));
    const callers = [
      {
        symbol: { file: 'src/a.ts', name: 'foo' },
        callers: [{ file: 'src/app.ts', name: 'runNoise', line: 7 }],
      },
    ];
    writeFileSync(
      join(configHome, 'lat', 'config.json'),
      JSON.stringify({
        knowledge_stores: [
          {
            name: 'fixture',
            label: 'Fixture',
            command: [
              process.execPath,
              providerScript,
              join(configHome, 'stdin.json'),
              JSON.stringify(callers),
            ],
            operations: ['callers'],
          },
        ],
      }),
    );
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    const { url, requests } = await decisionServer(dropNoise);
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);

    const output = await federateTags([doc], {
      projectRoot,
      stores: [storeWithTitles({ alpha: ['first'] })],
      prompt,
    });

    expect(output).toContain('- "runNoise (src/app.ts:7)"');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain('runNoise');
  });

  // @lat: [[fork-federate-decision-filter#An emptied document frees its emitted slot]]
  it('emits the next document when the filter empties the first', async () => {
    const { url } = await decisionServer(dropNoise);
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', url);
    const docs: TaggedDoc[] = [
      { id: 'a.md', tags: ['alpha'] },
      { id: 'b.md', tags: ['beta'] },
    ];
    const seen = new Set<string>();
    const output = await federateTags(docs, {
      projectRoot,
      stores: [storeWithTitles({ alpha: ['noise'], beta: ['useful'] })],
      prompt,
      maxEmitted: 1,
      concurrency: 1,
      seen,
    });
    expect(output).toContain('b.md (beta):');
    expect(output).not.toContain('a.md');
    expect([...seen]).toEqual(['b.md']);
  });
});
