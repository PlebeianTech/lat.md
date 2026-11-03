import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWikiCatalog } from '../src/wiki/catalog.js';

function createFixtureVault(files: Record<string, string>): {
  root: string;
  latDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'lat-wiki-catalog-'));
  const latDir = join(root, 'lat.md');
  mkdirSync(latDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(latDir, relPath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return { root, latDir };
}

describe('buildWikiCatalog', () => {
  it('selects docs across the four Diataxis directories and frontmatter-declared docs while collecting allSections', async () => {
    const { root, latDir } = createFixtureVault({
      'lat.md': '# Root Title\n\nRoot overview paragraph.\n',
      'tutorials/getting-started.md':
        '# Getting Started\n\nA beginner tutorial with [[target|Alias]].\n',
      'how-to/deploy.md': '# Deploy Guide\n\nHow to deploy the app.\n',
      'reference/api.md': '# API Reference\n\nAPI reference details.\n',
      'explanation/architecture.md':
        '# Architecture\n\nWhy the design works this way.\n',
      'custom-explanation.md':
        '---\nlat:\n  mode: explanation\n---\n# Custom\n\nCustom explanation at root.\n',
      'knowledge/internal.md': '# Internal\n\nInternal unclassified note.\n',
    });

    try {
      const catalog = await buildWikiCatalog(latDir, root);
      expect(catalog.latDir).toBe(latDir);
      expect(catalog.projectRoot).toBe(root);
      expect(catalog.rootTitle).toBe('Root Title');
      expect(catalog.rootOverview).toBe('Root overview paragraph.');

      const slugs = catalog.docs.map((d) => d.slug);
      expect(slugs).toContain('getting-started');
      expect(slugs).toContain('deploy');
      expect(slugs).toContain('api');
      expect(slugs).toContain('architecture');
      expect(slugs).toContain('custom-explanation');
      expect(slugs).not.toContain('internal');

      const tutorialDoc = catalog.docs.find(
        (d) => d.slug === 'getting-started',
      )!;
      expect(tutorialDoc.mode).toBe('tutorial');
      expect(tutorialDoc.title).toBe('Getting Started');
      expect(tutorialDoc.firstParagraph).toBe(
        'A beginner tutorial with [[target|Alias]].',
      );
      expect(tutorialDoc.relPath).toBe('tutorials/getting-started.md');
      expect(tutorialDoc.filePath).toBe('lat.md/tutorials/getting-started.md');

      const customDoc = catalog.docs.find(
        (d) => d.slug === 'custom-explanation',
      )!;
      expect(customDoc.mode).toBe('explanation');

      // allSections must include sections from both exported and non-exported documents
      const filePathsInSections = new Set(
        catalog.allSections.map((s) => s.filePath),
      );
      expect(filePathsInSections.has('lat.md/knowledge/internal.md')).toBe(
        true,
      );
      expect(filePathsInSections.has('lat.md/lat.md')).toBe(true);
      expect(
        filePathsInSections.has('lat.md/tutorials/getting-started.md'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes directory indexes, test specs with requireCodeMention, and unmodeled docs', async () => {
    const { root, latDir } = createFixtureVault({
      'lat.md': '# Project\n\nProject overview.\n',
      'how-to/how-to.md': '# How-To Index\n\nIndex of how-to guides.\n',
      'how-to/good-task.md': '# Good Task\n\nValid how-to doc.\n',
      'tests/spec.md':
        '---\nlat:\n  require-code-mention: true\n  mode: reference\n---\n# Test Spec\n\nInternal test specifications.\n',
      'notes/random.md': '# Random Notes\n\nUnclassified document.\n',
      'how-to/conflict.md':
        '---\nlat:\n  mode: reference\n---\n# Conflict\n\nConflicting mode declaration.\n',
    });

    try {
      const catalog = await buildWikiCatalog(latDir, root);
      const paths = catalog.docs.map((d) => d.relPath);
      expect(paths).toEqual(['how-to/good-task.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips leading YAML frontmatter, preserves [[target|alias]] syntax in firstParagraph and rootOverview, and handles root overview without H1', async () => {
    const { root, latDir } = createFixtureVault({
      'lat.md':
        '![lat.md](logo.svg)\n\n[![CI](https://example.com/badge)](https://example.com)\n\nLat is a knowledge graph with [[concepts#graph|Knowledge Graph]] for agents.\n\n## Section\n\nContent here.\n',
      'reference/config.md':
        '---\nlat:\n  mode: reference\n---\n# Configuration\n\nConfig parameters with [[types#Config|ConfigOptions]] overview.\n\nMore details.\n',
    });

    try {
      const catalog = await buildWikiCatalog(latDir, root);
      expect(catalog.rootTitle).toBeUndefined();
      expect(catalog.rootOverview).toBe(
        'Lat is a knowledge graph with [[concepts#graph|Knowledge Graph]] for agents.',
      );

      const configDoc = catalog.docs.find((d) => d.slug === 'config')!;
      expect(configDoc.firstParagraph).toBe(
        'Config parameters with [[types#Config|ConfigOptions]] overview.',
      );
      expect(configDoc.body.startsWith('---')).toBe(false);
      expect(configDoc.body).toContain(
        '# Configuration\n\nConfig parameters with [[types#Config|ConfigOptions]] overview.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('disambiguates page slugs deterministically when stems collide or match reserved wiki page names', async () => {
    const { root, latDir } = createFixtureVault({
      'lat.md': '# Docs\n\nDocs overview.\n',
      'tutorials/home.md': '# Home Tutorial\n\nTutorial overview.\n',
      'how-to/setup.md': '# Setup Recipe\n\nSetup recipe overview.\n',
      'reference/setup.md': '# Setup Reference\n\nSetup reference overview.\n',
      'how-to/sub/setup.md': '# Sub Setup\n\nSub setup overview.\n',
      'explanation/_sidebar.md':
        '# Sidebar Explanation\n\nSidebar explanation overview.\n',
    });

    try {
      const catalog = await buildWikiCatalog(latDir, root);
      const slugs = catalog.docs.map((d) => d.slug);
      // Reserved names must be disambiguated with mode
      expect(slugs).not.toContain('home');
      expect(slugs).not.toContain('_sidebar');
      expect(slugs).toContain('tutorial-home');
      expect(slugs).toContain('explanation-_sidebar');

      // Colliding stems must be disambiguated deterministically
      const setupDocs = catalog.docs.filter((d) =>
        d.relPath.endsWith('setup.md'),
      );
      const setupSlugs = setupDocs.map((d) => d.slug);
      expect(new Set(setupSlugs).size).toBe(setupDocs.length);
      expect(setupSlugs).toContain('reference-setup');
      expect(setupSlugs).toContain('how-to-setup');
      expect(setupSlugs).toContain('how-to-sub-setup');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips YAML frontmatter formatted with CRLF line endings', async () => {
    const { root, latDir } = createFixtureVault({
      'lat.md': '# Project\r\n\r\nProject overview.\r\n',
      'how-to/crlf.md':
        '---\r\nlat:\r\n  mode: how-to\r\n---\r\n# CRLF Recipe\r\n\r\nOverview.\r\n\r\n1. Step\r\n',
    });

    try {
      const catalog = await buildWikiCatalog(latDir, root);
      const crlfDoc = catalog.docs.find((d) => d.slug === 'crlf')!;
      expect(crlfDoc.body.startsWith('---')).toBe(false);
      expect(crlfDoc.body).toContain('# CRLF Recipe');
      expect(crlfDoc.mode).toBe('how-to');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
