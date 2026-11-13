import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  readGithubWikiWorkflowTemplate,
  renderGithubWikiWorkflow,
} from '../src/fork/github-wiki-workflow.js';
import { genCmd } from '../src/cli/gen.js';
import { rmDirBestEffort } from './util.js';

describe('github wiki workflow rendering', () => {
  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#Workflow Template Rendering#Replaces placeholders and preserves action syntax]]
  it('replaces template placeholders without disturbing GitHub Actions expressions', () => {
    const rawTemplate = readGithubWikiWorkflowTemplate();
    expect(rawTemplate).toContain('{{BRANCH}}');
    expect(rawTemplate).toContain('{{NODE_VERSION}}');
    expect(rawTemplate).toContain('{{LAT_PACKAGE}}');
    expect(rawTemplate).toContain('{{LAT_VERSION}}');

    const rendered = renderGithubWikiWorkflow();
    expect(rendered).not.toContain('{{BRANCH}}');
    expect(rendered).not.toContain('{{NODE_VERSION}}');
    expect(rendered).not.toContain('{{LAT_PACKAGE}}');
    expect(rendered).not.toContain('{{LAT_VERSION}}');
    expect(rendered).toContain('${{ secrets.GITHUB_TOKEN }}');
    expect(rendered).toContain('${{ runner.temp }}');
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#Workflow Template Rendering#Produces valid workflow structure with build and publish jobs]]
  it('produces valid YAML containing build and publish jobs', () => {
    const rendered = renderGithubWikiWorkflow();
    const doc = parse(rendered) as {
      jobs?: {
        build?: Record<string, unknown>;
        publish?: Record<string, unknown>;
      };
    };
    expect(doc).toBeDefined();
    expect(doc.jobs?.build).toBeDefined();
    expect(doc.jobs?.publish).toBeDefined();
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#Workflow Template Rendering#Configures push branch]]
  it('configures push branches by default and through options', () => {
    const defaultDoc = parse(renderGithubWikiWorkflow()) as {
      on: { push: { branches: string[] } };
    };
    expect(defaultDoc.on.push.branches).toEqual(['main']);

    const customDoc = parse(
      renderGithubWikiWorkflow({ branch: 'release' }),
    ) as {
      on: { push: { branches: string[] } };
    };
    expect(customDoc.on.push.branches).toEqual(['release']);
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#Workflow Template Rendering#Configures node version]]
  it('configures setup-node version by default and through options', () => {
    type Step = { uses?: string; with?: { 'node-version'?: string } };
    const defaultDoc = parse(renderGithubWikiWorkflow()) as {
      jobs: { build: { steps: Step[] } };
    };
    const defaultSetupNode = defaultDoc.jobs.build.steps.find(
      (s) =>
        typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node'),
    );
    expect(defaultSetupNode?.with?.['node-version']).toBe('lts/*');

    const customDoc = parse(
      renderGithubWikiWorkflow({ nodeVersion: '22' }),
    ) as {
      jobs: { build: { steps: Step[] } };
    };
    const customSetupNode = customDoc.jobs.build.steps.find(
      (s) =>
        typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node'),
    );
    expect(customSetupNode?.with?.['node-version']).toBe('22');
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#Workflow Template Rendering#Injects current package name and version]]
  it('references lat package name and version from package.json in the build step', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { name: string; version: string };
    const doc = parse(renderGithubWikiWorkflow()) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    const installStep = doc.jobs.build.steps.find(
      (s) =>
        typeof s.run === 'string' && s.run.startsWith('npm install --global'),
    );
    expect(installStep).toBeDefined();
    expect(installStep?.run).toContain(`${pkg.name}@${pkg.version}`);
  });
});

const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx'),
).href;
const repoRoot = join(import.meta.dirname, '..');

async function captureStdout(action: () => Promise<void>): Promise<string> {
  let output = '';
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return output;
}

describe('gen github-wiki-workflow cli command', () => {
  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#CLI Command#Replaces placeholders and preserves action syntax through stdout]]
  it('emits workflow without placeholders and preserves github actions syntax', async () => {
    const stdout = await captureStdout(async () => {
      await genCmd('github-wiki-workflow');
    });
    expect(stdout).not.toContain('{{BRANCH}}');
    expect(stdout).not.toContain('{{NODE_VERSION}}');
    expect(stdout).not.toContain('{{LAT_PACKAGE}}');
    expect(stdout).not.toContain('{{LAT_VERSION}}');
    expect(stdout).toContain('${{ secrets.GITHUB_TOKEN }}');
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#CLI Command#Modifies workflow output with branch and node options]]
  it('modifies emitted workflow when branch and nodeVersion options are provided', async () => {
    const defaultOutput = await captureStdout(async () => {
      await genCmd('github-wiki-workflow');
    });

    const branchOutput = await captureStdout(async () => {
      await genCmd('github-wiki-workflow', undefined, { branch: 'release-branch' });
    });
    expect(branchOutput).not.toEqual(defaultOutput);
    expect(branchOutput).toContain('release-branch');

    const nodeVersionOutput = await captureStdout(async () => {
      await genCmd('github-wiki-workflow', undefined, { nodeVersion: '22' });
    });
    expect(nodeVersionOutput).not.toEqual(defaultOutput);
    expect(nodeVersionOutput).toContain('22');
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#CLI Command#Preserves existing target behavior when options are supplied]]
  it('ignores options on unrelated targets such as agents.md', async () => {
    const baseOutput = await captureStdout(async () => {
      await genCmd('agents.md');
    });
    const withOptionsOutput = await captureStdout(async () => {
      await genCmd('agents.md', undefined, { branch: 'x', nodeVersion: '22' });
    });
    expect(withOptionsOutput).toEqual(baseOutput);
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#CLI Command#Exits with error code and lists supported targets on unknown target]]
  it('exits with status 1 and lists supported targets including github-wiki-workflow on unknown target', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never));
    let errorOutput = '';
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errorOutput += args.join(' ');
      });
    try {
      await genCmd('nonsense');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorOutput).toContain('github-wiki-workflow');
      expect(errorOutput).toContain('Unknown target: nonsense.');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // @lat: [[gen-github-wiki-workflow#Gen GitHub Wiki Workflow Tests#CLI Command#Wires CLI flags through commander to workflow generation]]
  it('wires cli flags through commander when spawned with tsx loader', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'lat-gen-cli-test-'));
    try {
      const env = { ...process.env };
      delete env.LAT_USAGE;
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          tsxLoader,
          join(repoRoot, 'src/cli/index.ts'),
          'gen',
          'github-wiki-workflow',
          '--branch',
          'release',
          '--node-version',
          '22',
        ],
        {
          cwd: tmpDir,
          env,
          encoding: 'utf-8',
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('{{BRANCH}}');
      expect(result.stdout).not.toContain('{{NODE_VERSION}}');
      expect(result.stdout).not.toContain('{{LAT_PACKAGE}}');
      expect(result.stdout).not.toContain('{{LAT_VERSION}}');
      expect(result.stdout).toContain('release');
      expect(result.stdout).toContain('22');
      expect(result.stdout).toContain('${{ secrets.GITHUB_TOKEN }}');
    } finally {
      rmDirBestEffort(tmpDir);
    }
  });
});
