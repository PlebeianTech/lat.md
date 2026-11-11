import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  readGithubWikiWorkflowTemplate,
  renderGithubWikiWorkflow,
} from '../src/fork/github-wiki-workflow.js';

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
