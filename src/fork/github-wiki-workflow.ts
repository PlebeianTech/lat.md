import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from '@plebeiantech/lat.md-core/cli';
import { findTemplatesDir } from '../cli/templates.js';

function packageName(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const candidate = join(dir, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (typeof parsed?.name === 'string') return parsed.name;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return '@plebeiantech/lat.md';
    dir = parent;
  }
}

export function readGithubWikiWorkflowTemplate(): string {
  return readFileSync(
    join(findTemplatesDir(), 'github-wiki-workflow.yml'),
    'utf-8',
  );
}

// @lat: [[cli#CLI#wiki]]
export function renderGithubWikiWorkflow(
  options: { branch?: string; nodeVersion?: string } = {},
): string {
  const branch = options.branch ?? 'main';
  const nodeVersion = options.nodeVersion ?? 'lts/*';
  const pkgName = packageName(import.meta.url);
  const pkgVersion = packageVersion(import.meta.url);

  return readGithubWikiWorkflowTemplate()
    .replaceAll('{{BRANCH}}', branch)
    .replaceAll('{{NODE_VERSION}}', nodeVersion)
    .replaceAll('{{LAT_PACKAGE}}', pkgName)
    .replaceAll('{{LAT_VERSION}}', pkgVersion);
}
