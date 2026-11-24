import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  plainStyler,
  type CmdContext,
} from '@plebeiantech/lat.md-core/context';
import { impactCommand } from '../src/cli/impact.js';
import { rmDirBestEffort } from './util.js';

const providerScript = join(__dirname, 'fixtures/callers-provider.cjs');
const OUTPUT_BUDGET_BYTES = 4119;
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

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function contextFor(root: string): CmdContext {
  return {
    latDir: join(root, 'lat.md'),
    projectRoot: root,
    styler: plainStyler,
    mode: 'cli',
  };
}

function registerProvider(output: unknown): string {
  const stdinFile = join(tempDir('lat-impact-callers-stdin-'), 'stdin.json');
  const configHome = tempDir('lat-impact-callers-config-');
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
            '0',
          ],
          operations: ['callers'],
        },
      ],
    }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
  return stdinFile;
}

function withoutProvider(): void {
  vi.stubEnv('XDG_CONFIG_HOME', tempDir('lat-impact-callers-empty-'));
}

/** `foo` carries a link to Target. `baz` calls `foo` and links to Caller. */
function makeProject(): string {
  const root = tempDir('lat-impact-callers-');
  writeFiles(root, {
    'lat.md/notes.md':
      '# Notes\n\n## Target\n\nThe target.\n\n## Caller\n\nLinked from baz.\n',
    'src/a.ts': '// @lat: [[notes#Notes#Target]]\nexport function foo() {}\n',
    'src/b.ts':
      '// @lat: [[notes#Notes#Caller]]\nexport function baz() {\n  foo();\n}\n',
  });
  return root;
}

const bazCallsFoo = [
  {
    symbol: { file: 'src/a.ts', name: 'foo' },
    callers: [{ file: 'src/b.ts', name: 'baz', line: 2 }],
  },
];

const target = 'notes#Notes#Target';

describe('lat impact --callers', () => {
  // @lat: [[fork-impact-callers#Fork Impact Callers#Sections of callers are listed under via callers]]
  it('lists the section linked to a caller of the linked function', async () => {
    const stdinFile = registerProvider(bazCallsFoo);
    const root = makeProject();

    const { output } = await impactCommand(contextFor(root), target, {
      callers: true,
    });

    expect(output).toContain('\nvia callers (1):\n  lat.md/notes#Notes#Caller');
    expect(output).toMatch(/Caller {2}lat\.md\/notes\.md:\d+/);
    expect(output).not.toContain('No callers provider');
    expect(JSON.parse(readFileSync(stdinFile, 'utf-8'))).toMatchObject({
      operation: 'callers',
      depth: 1,
      symbols: [{ file: 'src/a.ts', name: 'foo' }],
    });
  });

  // @lat: [[fork-impact-callers#Fork Impact Callers#Without callers the output is unchanged]]
  it('prints exactly the old output without --callers', async () => {
    registerProvider(bazCallsFoo);
    const root = makeProject();

    const plain = await impactCommand(contextFor(root), target, {});
    const explicitOff = await impactCommand(contextFor(root), target, {
      callers: false,
    });

    expect(plain.output).toBe(explicitOff.output);
    expect(plain.output).not.toContain('via callers');
    expect(plain.output).not.toContain('lat.md/notes#Notes#Caller');
  });

  // @lat: [[fork-impact-callers#Fork Impact Callers#Without a provider one note is added]]
  it('adds one note line when no provider is configured', async () => {
    withoutProvider();
    const root = makeProject();

    const plain = await impactCommand(contextFor(root), target, {});
    const withCallers = await impactCommand(contextFor(root), target, {
      callers: true,
    });

    expect(withCallers.output).toBe(
      `${plain.output}\n\nNo callers provider is configured.`,
    );
  });

  // @lat: [[fork-impact-callers#Fork Impact Callers#A large caller list stays within the budget]]
  it('keeps a large caller list within the output budget', async () => {
    const count = 300;
    const root = tempDir('lat-impact-callers-large-');
    const sections = Array.from(
      { length: count },
      (_, i) => `## Caller ${i}\n\nLinked from baz${i}.\n`,
    );
    const callers = Array.from({ length: count }, (_, i) => ({
      file: 'src/b.ts',
      name: `baz${i}`,
      line: i * 3 + 2,
    }));
    writeFiles(root, {
      'lat.md/notes.md': `# Notes\n\n## Target\n\nThe target.\n\n${sections.join('\n')}`,
      'src/a.ts': '// @lat: [[notes#Notes#Target]]\nexport function foo() {}\n',
      'src/b.ts': callers
        .map(
          (c, i) =>
            `// @lat: [[notes#Notes#Caller ${i}]]\nexport function ${c.name}() {}\n`,
        )
        .join(''),
    });
    registerProvider([{ symbol: { file: 'src/a.ts', name: 'foo' }, callers }]);

    const { output } = await impactCommand(contextFor(root), target, {
      callers: true,
    });

    expect(Buffer.byteLength(output)).toBeLessThan(OUTPUT_BUDGET_BYTES);
    expect(output).toContain('via callers (300):');
    expect(output).toMatch(/\n\d+ more not shown \(--all lists them\)$/);
  });
});
