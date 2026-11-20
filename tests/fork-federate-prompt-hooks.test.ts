import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleAntigravityPreInvocation } from '../src/fork/antigravity-hook.js';

const CLI = join(resolve(import.meta.dirname, '..'), 'dist/src/cli/index.js');
const prompt = 'Explain [[alpha-doc#Alpha Doc]] to me';
const dirsToClean: PathLike[] = [];
const serversToClose: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of serversToClose.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-federate-prompt-hooks-'));
  dirsToClean.push(dir);
  return dir;
}

/** A project whose one lat.md document carries the tag `alpha`. */
function taggedProject(): string {
  const project = tempDir();
  spawnSync('git', ['init', '-q'], { cwd: project });
  mkdirSync(join(project, 'lat.md'));
  writeFileSync(
    join(project, 'lat.md', 'alpha-doc.md'),
    '---\nlat:\n  tags: [alpha]\n---\n\n# Alpha Doc\n\nAbout alpha.\n',
  );
  return project;
}

/** A config directory whose external store answers every query with two hits. */
function configDirWithFakeStore(): string {
  const configHome = tempDir();
  const storeScript = join(configHome, 'store.cjs');
  const hits = [
    { key: 'k1', title: 'keep me', detail: 'useful detail', score: 9 },
    { key: 'k2', title: 'noise', detail: 'unrelated detail', score: 8 },
  ];
  writeFileSync(
    storeScript,
    `process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(hits))}));
`,
  );
  mkdirSync(join(configHome, 'lat'));
  writeFileSync(
    join(configHome, 'lat', 'config.json'),
    JSON.stringify({
      knowledge_stores: [
        {
          name: 'fake',
          label: 'Fake store',
          command: [process.execPath, storeScript],
        },
      ],
    }),
  );
  return configHome;
}

/** A decision model that records each request's question and drops "noise". */
async function decisionServer(): Promise<{
  url: string;
  questions: string[];
}> {
  const questions: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const { state } = JSON.parse(body) as {
        state: { question: string; section: string };
      };
      questions.push(state.question);
      const noise = state.section.includes('noise');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          answers: { relevant: { noul: noise ? 0.1 : 0.9 } },
        }),
      );
    });
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/decide`, questions };
}

type HookRun = { context: string; questions: string[] };

/** Runs the built Claude Code UserPromptSubmit hook. */
async function runClaudeHook(rerankUrl?: string): Promise<HookRun> {
  const project = taggedProject();
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: configDirWithFakeStore(),
    LAT_FEDERATION_RERANK_URL: undefined,
  };
  const model = await decisionServer();
  if (rerankUrl === 'fixture') env.LAT_FEDERATION_RERANK_URL = model.url;
  // Asynchronous, so this process can still answer the decision model.
  const child = spawn('node', [CLI, 'hook', 'claude', 'UserPromptSubmit'], {
    cwd: project,
    env: env as NodeJS.ProcessEnv,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stdin.end(
    JSON.stringify({ session_id: randomUUID(), user_prompt: prompt }),
  );
  const status = await new Promise((resolve) => child.on('close', resolve));
  expect(status).toBe(0);
  const output = JSON.parse(stdout);
  return {
    context: output.hookSpecificOutput.additionalContext,
    questions: model.questions,
  };
}

/** Runs the Antigravity PreInvocation hook in this process. */
async function runAntigravityHook(rerankUrl?: string): Promise<HookRun> {
  const project = taggedProject();
  vi.stubEnv('XDG_CONFIG_HOME', configDirWithFakeStore());
  vi.stubEnv('LAT_FEDERATION_RERANK_URL', undefined);
  const model = await decisionServer();
  if (rerankUrl === 'fixture')
    vi.stubEnv('LAT_FEDERATION_RERANK_URL', model.url);
  const output = await handleAntigravityPreInvocation(
    JSON.stringify({
      conversationId: randomUUID(),
      workspacePaths: [project],
      user_prompt: prompt,
    }),
    false,
  );
  return {
    context: output.injectSteps[0].ephemeralMessage ?? '',
    questions: model.questions,
  };
}

describe.each([
  ['Claude Code UserPromptSubmit', runClaudeHook],
  ['Antigravity PreInvocation', runAntigravityHook],
])('%s federation', (_name, runHook) => {
  // @lat: [[fork-federate-prompt-hooks#Each prompt hook sends the prompt to the decision model]]
  it('sends the prompt to the decision model and drops a hit it scores low', async () => {
    const { context, questions } = await runHook('fixture');
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((question) => question === prompt)).toBe(true);
    expect(context).toContain('keep me');
    expect(context).not.toContain('noise');
  });

  // @lat: [[fork-federate-prompt-hooks#Without the variable the hooks keep every hit]]
  it('keeps every hit and sends nothing without the variable', async () => {
    const { context, questions } = await runHook();
    expect(questions).toHaveLength(0);
    expect(context).toContain('keep me');
    expect(context).toContain('noise');
  });
});
