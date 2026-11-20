import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckRunContext } from '@plebeiantech/lat.md-core/cli/check-context';
import { rmDirBestEffort } from './util.js';
import { findUnreviewedSectionsForDiff } from '../src/cli/fork-stop-impact.js';
import { formatStopReason, getStopStatus } from '../src/cli/hook.js';
import { handleAntigravityStop } from '../src/fork/antigravity-hook.js';

const providerScript = join(__dirname, 'fixtures/callers-provider.cjs');
const callerLinePrefix = 'Sections linked to callers of modified code:';
const dirsToClean: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirsToClean.splice(0)) rmDirBestEffort(dir);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirsToClean.push(dir);
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Lat Tests',
  GIT_AUTHOR_EMAIL: 'lat@example.invalid',
  GIT_COMMITTER_NAME: 'Lat Tests',
  GIT_COMMITTER_EMAIL: 'lat@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function linkComments(sectionNames: string[]): string {
  return sectionNames.map((name) => `// @lat: [[doc#Doc#${name}]]\n`).join('');
}

/** `bar` has a 40 line body, and `untouched` sits below it. */
function barSource(barLinks: string[], value: string): string {
  const body = `  noop(${value});\n`.repeat(40);
  return (
    linkComments(barLinks) +
    `export function bar(): void {\n${body}}\n\nexport function untouched(): void {}\n`
  );
}

function fooSource(fooLinks: string[]): string {
  return `${linkComments(fooLinks)}export function foo(): number {\n  return bar();\n}\n`;
}

/**
 * Commit `src/a.ts` (bar), `src/b.ts` (foo, which calls bar) and
 * `lat.md/doc.md` holding `sectionNames`, then change the body of bar only.
 * The links are the `@lat:` comments above bar and above foo.
 */
function makeRepo(options: {
  sectionNames: string[];
  barLinks?: string[];
  fooLinks: string[];
}): string {
  const { sectionNames, barLinks = [], fooLinks } = options;
  const repo = tempDir('lat-stop-callers-');
  const doc = [
    '# Doc',
    '',
    'Doc overview.',
    '',
    ...sectionNames.flatMap((name) => [`## ${name}`, '', `About ${name}.`, '']),
  ].join('\n');
  writeFiles(repo, {
    'lat.md/.gitignore': '.cache/\n',
    'lat.md/lat.md': '# Project\n\n- [[doc]] — Doc\n',
    'lat.md/doc.md': doc,
    'src/a.ts': barSource(barLinks, 'before'),
    'src/b.ts': fooSource(fooLinks),
  });
  git(repo, 'init', '--quiet');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  writeFiles(repo, { 'src/a.ts': barSource(barLinks, 'after') });
  return repo;
}

function rewriteParagraph(repo: string, name: string): void {
  const path = join(repo, 'lat.md/doc.md');
  writeFileSync(
    path,
    readFileSync(path, 'utf-8').replace(
      `About ${name}.`,
      `About ${name}, rewritten.`,
    ),
  );
}

/**
 * Registers a fixture callers provider that prints `output` and exits with
 * `exitCode` for any request. Returns the file that receives its stdin.
 */
function registerProvider(output: unknown, exitCode = 0): string {
  const stdinFile = join(tempDir('lat-stop-callers-stdin-'), 'stdin.json');
  const configHome = tempDir('lat-stop-callers-config-');
  mkdirSync(join(configHome, 'lat'));
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
            stdinFile,
            JSON.stringify(output),
            String(exitCode),
          ],
          operations: ['callers'],
        },
      ],
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
  return stdinFile;
}

/** The provider's answer: `foo` in src/b.ts calls bar. */
const fooCallsBar = [
  {
    symbol: { file: 'src/a.ts', name: 'bar' },
    callers: [{ file: 'src/b.ts', name: 'foo', line: 2 }],
  },
];

function reviewStatus(repo: string) {
  return findUnreviewedSectionsForDiff(
    repo,
    new CheckRunContext(join(repo, 'lat.md'), repo),
  );
}

async function stopReason(repo: string): Promise<string | null> {
  return formatStopReason(await getStopStatus(join(repo, 'lat.md')));
}

describe('fork stop impact caller sections', () => {
  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#Caller section is listed after the direct list]]
  it('names the section linked to a caller of the changed function', async () => {
    registerProvider(fooCallsBar);
    const repo = makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] });

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 0,
      unreviewedSections: [],
      callerSections: ['lat.md/doc#Doc#Callers'],
    });

    const freshRepo = makeRepo({
      sectionNames: ['Callers'],
      fooLinks: ['Callers'],
    });
    const reason = await stopReason(freshRepo);
    expect(reason).toContain(`${callerLinePrefix} [[lat.md/doc#Doc#Callers]]`);
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#Only changed symbols are sent to the provider]]
  it('asks the provider for the callers of changed symbols at depth 1', async () => {
    const stdinFile = registerProvider(fooCallsBar);
    const repo = makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] });

    await reviewStatus(repo);

    expect(JSON.parse(readFileSync(stdinFile, 'utf-8'))).toMatchObject({
      operation: 'callers',
      depth: 1,
      symbols: [{ file: 'src/a.ts', name: 'bar' }],
    });
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#Without a provider the Stop reason is unchanged]]
  it('adds nothing without a provider and only the caller line with one', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', tempDir('lat-stop-callers-empty-'));
    const withoutProvider = await stopReason(
      makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] }),
    );
    expect(withoutProvider).not.toContain(callerLinePrefix);

    registerProvider(fooCallsBar);
    const withProvider = await stopReason(
      makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] }),
    );
    expect(withProvider).toBe(
      `${withoutProvider}\n\n${callerLinePrefix} [[lat.md/doc#Doc#Callers]]`,
    );
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#A failing provider leaves the Stop reason unchanged]]
  it('adds nothing when the provider fails', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', tempDir('lat-stop-callers-empty-'));
    const withoutProvider = await stopReason(
      makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] }),
    );

    registerProvider(fooCallsBar, 1);
    const repo = makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] });
    expect((await reviewStatus(repo)).callerSections).toEqual([]);
    const withFailingProvider = await stopReason(
      makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] }),
    );
    expect(withFailingProvider).toBe(withoutProvider);
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#Reviewed direct sections skip the lookup and keep the reminder cleared]]
  it('skips the lookup when every direct linked section is reviewed', async () => {
    const stdinFile = registerProvider(fooCallsBar);
    const repo = makeRepo({
      sectionNames: ['Direct', 'Callers'],
      barLinks: ['Direct'],
      fooLinks: ['Callers'],
    });
    rewriteParagraph(repo, 'Direct');

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: [],
      callerSections: [],
    });
    expect(existsSync(stdinFile)).toBe(false);

    const freshRepo = makeRepo({
      sectionNames: ['Direct', 'Callers'],
      barLinks: ['Direct'],
      fooLinks: ['Callers'],
    });
    rewriteParagraph(freshRepo, 'Direct');
    const status = await getStopStatus(join(freshRepo, 'lat.md'));
    expect(status.needsSync).toBe(false);
    expect(status.callerSections).toEqual([]);
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#Caller sections never repeat an unreviewed direct section]]
  it('lists caller sections beside an unreviewed direct section without repeating the direct one', async () => {
    registerProvider(fooCallsBar);
    const repo = makeRepo({
      sectionNames: ['Direct', 'Callers'],
      barLinks: ['Direct'],
      fooLinks: ['Direct', 'Callers'],
    });

    expect(await reviewStatus(repo)).toEqual({
      linkedSectionCount: 1,
      unreviewedSections: ['lat.md/doc#Doc#Direct'],
      callerSections: ['lat.md/doc#Doc#Callers'],
    });

    const freshRepo = makeRepo({
      sectionNames: ['Direct', 'Callers'],
      barLinks: ['Direct'],
      fooLinks: ['Direct', 'Callers'],
    });
    expect(await stopReason(freshRepo)).toMatch(
      new RegExp(
        `Sections linked to modified code: \\[\\[lat.md/doc#Doc#Direct\\]\\]\\n${callerLinePrefix} \\[\\[lat.md/doc#Doc#Callers\\]\\]$`,
      ),
    );
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#An edited caller section is not listed]]
  it('leaves out a caller section that was edited in the working tree', async () => {
    registerProvider(fooCallsBar);
    const repo = makeRepo({
      sectionNames: ['Reviewed', 'Callers'],
      fooLinks: ['Reviewed', 'Callers'],
    });
    rewriteParagraph(repo, 'Reviewed');

    expect((await reviewStatus(repo)).callerSections).toEqual([
      'lat.md/doc#Doc#Callers',
    ]);
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#Seven caller sections print five]]
  it('prints five of seven caller sections, sorted', async () => {
    registerProvider(fooCallsBar);
    const names = Array.from({ length: 7 }, (_, i) => `Item${i + 1}`);
    const repo = makeRepo({ sectionNames: names, fooLinks: names });

    expect((await reviewStatus(repo)).callerSections).toEqual(
      names.slice(0, 5).map((name) => `lat.md/doc#Doc#${name}`),
    );

    const freshRepo = makeRepo({ sectionNames: names, fooLinks: names });
    const reason = await stopReason(freshRepo);
    const callerLine = reason
      ?.split('\n')
      .find((line) => line.startsWith(callerLinePrefix));
    expect(callerLine?.match(/\[\[/g)).toHaveLength(5);
  });

  // @lat: [[fork-stop-impact-callers#Fork Stop Impact Callers#The Antigravity Stop handler carries the caller line]]
  it('puts the caller line in the Antigravity Stop reason', async () => {
    registerProvider(fooCallsBar);
    const repo = makeRepo({ sectionNames: ['Callers'], fooLinks: ['Callers'] });

    const output = await handleAntigravityStop(
      JSON.stringify({ workspacePaths: [repo] }),
      false,
    );

    expect(output.decision).toBe('continue');
    expect(output.reason).toContain(
      `${callerLinePrefix} [[lat.md/doc#Doc#Callers]]`,
    );
  });
});
