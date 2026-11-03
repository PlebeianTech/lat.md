import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWikiCatalog } from '../src/wiki/catalog.js';
import {
  transformWikiCatalog,
  transformWikiDocument,
} from '../src/wiki/transform.js';

function createFixtureProject(): { root: string; latDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lat-wiki-transform-'));
  const latDir = join(root, 'lat.md');
  mkdirSync(latDir, { recursive: true });

  // Source files
  const tsFile = join(root, 'src', 'calc.ts');
  mkdirSync(join(tsFile, '..'), { recursive: true });
  writeFileSync(
    tsFile,
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );

  const rbFile = join(root, 'app', 'models', 'user.rb');
  mkdirSync(join(rbFile, '..'), { recursive: true });
  writeFileSync(rbFile, 'class User\n  def valid?\n    true\n  end\nend\n');

  const pkgJson = join(root, 'package.json');
  writeFileSync(pkgJson, '{\n  "name": "fixture"\n}\n');

  // Vault files
  writeFileSync(
    join(latDir, 'lat.md'),
    '# Demo Project\n\nWelcome to [[tutorials/intro#Getting Started|Quick Start]] and [deploy guide](how-to/deploy.md).\n',
  );

  const introDir = join(latDir, 'tutorials');
  mkdirSync(introDir, { recursive: true });
  writeFileSync(
    join(introDir, 'intro.md'),
    '# Getting Started\n\nIntro overview with [[how-to/deploy#Deploy Guide#Production Step|Deploy Info]].\n\nSee [[deploy#Production Step]] for details.\n\n```ts\nconst test = "[[not_a_link]]";\n```\n\nInline `[[not_a_link]]` and `[no link](url.md)` preserved.\n\n![Image](logo.png)\n\n[External](https://example.com)\n\n[Same Page](#getting-started)\n',
  );

  const howToDir = join(latDir, 'how-to');
  mkdirSync(howToDir, { recursive: true });
  writeFileSync(
    join(howToDir, 'deploy.md'),
    '# Deploy Guide\n\nDeploy overview.\n\n## Production Step\n\nStep details.\n\nLink to relative [intro](../tutorials/intro.md) doc.\n\nLink to repo file [package.json](../../package.json).\n\nLink to repo dir [src dir](../../src).\n\nLink to outside [escape](../../../../etc/passwd).\n',
  );

  const testSpecDir = join(latDir, 'tests');
  mkdirSync(testSpecDir, { recursive: true });
  writeFileSync(
    join(testSpecDir, 'spec.md'),
    '---\nlat:\n  require-code-mention: true\n---\n# Test Suite\n\n## Verification\n\nVerification spec details.\n',
  );

  const refDir = join(latDir, 'reference');
  mkdirSync(refDir, { recursive: true });
  writeFileSync(
    join(refDir, 'symbols.md'),
    '# Symbols\n\nSymbol overview with [[src/calc.ts#add]], [[app/models/user.rb#User#valid?]], [[src]], and [[package.json]]. Also [[missing-target]] and [[tests/spec#Test Suite#Verification|Spec Verification]].\n',
  );

  return { root, latDir };
}

describe('transformWikiDocument and transformWikiCatalog', () => {
  it('rewrites wiki links between exported Diataxis docs in body, firstParagraph, and rootOverview', async () => {
    const { root, latDir } = createFixtureProject();
    try {
      const rawCatalog = await buildWikiCatalog(latDir, root);
      const transformed = await transformWikiCatalog(rawCatalog, {
        repoUrl: 'https://github.com/my-org/my-repo',
        ref: 'main',
      });

      // rootOverview transformation
      expect(transformed.rootOverview).toContain('[Quick Start](intro)');
      expect(transformed.rootOverview).toContain('[deploy guide](deploy)');

      const introDoc = transformed.docs.find((d) => d.slug === 'intro')!;
      // firstParagraph transformation
      expect(introDoc.firstParagraph).toContain(
        '[Deploy Info](deploy#production-step)',
      );

      // body transformation for full ref and short ref
      expect(introDoc.body).toContain('[Deploy Info](deploy#production-step)');
      expect(introDoc.body).toContain(
        '[Production Step](deploy#production-step)',
      );

      // code block and inline code safety
      expect(introDoc.body).toContain('const test = "[[not_a_link]]";');
      expect(introDoc.body).toContain(
        'Inline `[[not_a_link]]` and `[no link](url.md)` preserved.',
      );

      // Markdown image, external link, same page anchor untouched
      expect(introDoc.body).toContain('![Image](logo.png)');
      expect(introDoc.body).toContain('[External](https://example.com)');
      expect(introDoc.body).toContain('[Same Page](#getting-started)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites non-exported section links to GitHub blob URLs with anchor or plain text when repoUrl is omitted', async () => {
    const { root, latDir } = createFixtureProject();
    try {
      const rawCatalog = await buildWikiCatalog(latDir, root);

      // With repoUrl
      const transformedWithRepo = await transformWikiCatalog(rawCatalog, {
        repoUrl: 'https://github.com/my-org/my-repo',
        ref: 'v1.0.0',
      });
      const symDocWithRepo = transformedWithRepo.docs.find(
        (d) => d.slug === 'symbols',
      )!;
      expect(symDocWithRepo.body).toContain(
        '[Spec Verification](https://github.com/my-org/my-repo/blob/v1.0.0/lat.md/tests/spec.md#verification)',
      );

      // Without repoUrl -> plain text label
      const transformedNoRepo = await transformWikiCatalog(rawCatalog);
      const symDocNoRepo = transformedNoRepo.docs.find(
        (d) => d.slug === 'symbols',
      )!;
      expect(symDocNoRepo.body).toContain('Spec Verification');
      expect(symDocNoRepo.body).not.toContain('https://github.com');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites source symbol links and bare repository path links to line ranges and handles missing targets', async () => {
    const { root, latDir } = createFixtureProject();
    try {
      const rawCatalog = await buildWikiCatalog(latDir, root);

      // With repoUrl
      const transformedWithRepo = await transformWikiCatalog(rawCatalog, {
        repoUrl: 'https://github.com/my-org/my-repo',
      });
      const symDoc = transformedWithRepo.docs.find(
        (d) => d.slug === 'symbols',
      )!;

      // TypeScript function line range (add is lines 1 to 3)
      expect(symDoc.body).toContain(
        '[add](https://github.com/my-org/my-repo/blob/HEAD/src/calc.ts#L1-L3)',
      );

      // Ruby method line range (valid? is lines 2 to 4)
      expect(symDoc.body).toContain(
        '[User#valid?](https://github.com/my-org/my-repo/blob/HEAD/app/models/user.rb#L2-L4)',
      );

      // Bare file link
      expect(symDoc.body).toContain(
        '[package.json](https://github.com/my-org/my-repo/blob/HEAD/package.json)',
      );

      // Directory link resolves to /tree/
      expect(symDoc.body).toContain(
        '[src](https://github.com/my-org/my-repo/tree/HEAD/src)',
      );

      // Missing target -> plain text
      expect(symDoc.body).toContain('missing-target');
      expect(symDoc.body).not.toContain('[[missing-target]]');

      // Without repoUrl
      const transformedNoRepo = await transformWikiCatalog(rawCatalog);
      const symDocNoRepo = transformedNoRepo.docs.find(
        (d) => d.slug === 'symbols',
      )!;
      expect(symDocNoRepo.body).toContain('add');
      expect(symDocNoRepo.body).toContain('User#valid?');
      expect(symDocNoRepo.body).toContain('package.json');
      expect(symDocNoRepo.body).toContain('src');
      expect(symDocNoRepo.body).toContain('missing-target');
      expect(symDocNoRepo.body).not.toContain('https://github.com');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites relative Markdown links to wiki page slugs or repository files, resolving directories to tree and preserving escaped paths', async () => {
    const { root, latDir } = createFixtureProject();
    try {
      const rawCatalog = await buildWikiCatalog(latDir, root);
      const transformed = await transformWikiCatalog(rawCatalog, {
        repoUrl: 'https://github.com/my-org/my-repo',
      });
      const deployDoc = transformed.docs.find((d) => d.slug === 'deploy')!;

      // Link to another Diataxis doc: ../tutorials/intro.md -> intro
      expect(deployDoc.body).toContain('[intro](intro)');

      // Link to repository file: ../../package.json -> package.json blob URL
      expect(deployDoc.body).toContain(
        '[package.json](https://github.com/my-org/my-repo/blob/HEAD/package.json)',
      );

      // Link to repository directory: ../../src -> tree URL
      expect(deployDoc.body).toContain(
        '[src dir](https://github.com/my-org/my-repo/tree/HEAD/src)',
      );

      // Link escaping project root: preserved untouched, not rewritten to blob URL
      expect(deployDoc.body).toContain('[escape](../../../../etc/passwd)');
      expect(deployDoc.body).not.toContain('blob/HEAD/etc/passwd');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('transforms an individual document via transformWikiDocument', async () => {
    const { root, latDir } = createFixtureProject();
    try {
      const rawCatalog = await buildWikiCatalog(latDir, root);
      const intro = rawCatalog.docs.find((d) => d.slug === 'intro')!;
      const transformed = await transformWikiDocument(intro, rawCatalog, {
        repoUrl: 'https://github.com/my-org/my-repo',
      });
      expect(transformed.slug).toBe('intro');
      expect(transformed.firstParagraph).toContain(
        '[Deploy Info](deploy#production-step)',
      );
      expect(transformed.body).toContain(
        '[Production Step](deploy#production-step)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
