import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = join(import.meta.dirname, '..');
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx'),
).href;
const fixtureServerVersion = '9.9.9-fixture';

let fixtureRoot: string;
let consumerFile: string;

function writeFixtureFile(relativePath: string, content: string): void {
  const path = join(fixtureRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lat-vendor-ui-server-'));
  writeFixtureFile('package.json', '{ "type": "module" }\n');
  writeFixtureFile(
    'packages/server/package.json',
    `${JSON.stringify({ name: '@lat.md/server', version: fixtureServerVersion, type: 'module' })}\n`,
  );
  writeFixtureFile(
    'packages/server/dist/index.js',
    [
      "import { readFileSync } from 'node:fs';",
      'export function getLatServerVersion() {',
      "  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;",
      '}',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    'dist/src/view/server-build.js',
    [
      "import { getLatServerVersion } from '@lat.md/server';",
      "export const dependencies = () => ({ '@lat.md/server': getLatServerVersion() });",
      '',
    ].join('\n'),
  );
  mkdirSync(join(fixtureRoot, 'scripts'));
  copyFileSync(
    join(repositoryRoot, 'scripts/fork-vendor-ui-server.ts'),
    join(fixtureRoot, 'scripts/fork-vendor-ui-server.ts'),
  );
  consumerFile = join(fixtureRoot, 'dist/src/view/server-build.js');

  const vendoring = spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoader,
      join(fixtureRoot, 'scripts/fork-vendor-ui-server.ts'),
    ],
    { encoding: 'utf8' },
  );
  if (vendoring.status !== 0) {
    throw new Error(`Vendoring failed: ${vendoring.stderr}`);
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('fork-vendor-ui-server.ts', () => {
  // @lat: [[tests/fork-vendor-ui-server#Fork Vendor UI Server#The vendored server reads its own version]]
  it('lets the vendored server read the version from its package.json', () => {
    const consumerUrl = pathToFileURL(consumerFile).href;
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { dependencies } from '${consumerUrl}'; console.log(JSON.stringify(dependencies()));`,
      ],
      { encoding: 'utf8' },
    );
    expect(run.stderr).toBe('');
    expect(Object.values(JSON.parse(run.stdout))).toEqual([
      fixtureServerVersion,
    ]);
  });

  // @lat: [[tests/fork-vendor-ui-server#Fork Vendor UI Server#Only import specifiers are rewritten]]
  it('rewrites the import but keeps the package name as a dependency key', () => {
    const rewritten = readFileSync(consumerFile, 'utf8');
    expect(rewritten).not.toContain("from '@lat.md/server'");
    expect(rewritten).toContain(
      "({ '@lat.md/server': getLatServerVersion() })",
    );
  });
});
