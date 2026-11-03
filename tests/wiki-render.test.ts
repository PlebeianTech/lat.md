import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WikiCatalog, WikiCatalogDoc } from '../src/wiki/catalog.js';
import { renderWikiBundle, writeWikiBundle } from '../src/wiki/render.js';

function createMockCatalog(): WikiCatalog {
  const docs: WikiCatalogDoc[] = [
    {
      mode: 'tutorial',
      slug: 'get-started',
      title: 'Get Started',
      firstParagraph: 'Beginner tutorial walkthrough.',
      relPath: 'tutorials/get-started.md',
      filePath: 'lat.md/tutorials/get-started.md',
      body: '# Get Started\n\nBeginner tutorial walkthrough.\n',
      sections: [],
    },
    {
      mode: 'how-to',
      slug: 'deploy-app',
      title: 'Deploy App',
      firstParagraph: 'Steps to deploy the app.',
      relPath: 'how-to/deploy-app.md',
      filePath: 'lat.md/how-to/deploy-app.md',
      body: '# Deploy App\n\nSteps to deploy the app.\n',
      sections: [],
    },
    {
      mode: 'explanation',
      slug: 'architecture',
      title: 'Architecture',
      firstParagraph: '',
      relPath: 'explanation/architecture.md',
      filePath: 'lat.md/explanation/architecture.md',
      body: '# Architecture\n\nWhy we chose this design.\n',
      sections: [],
    },
  ];

  return {
    latDir: '/mock/lat.md',
    projectRoot: '/mock',
    rootTitle: 'My Project',
    rootOverview: 'Knowledge graph overview for my project.',
    docs,
    allSections: [],
  };
}

describe('renderWikiBundle and writeWikiBundle', () => {
  it('renders Home.md and _Sidebar.md in canonical Diataxis order and omits empty mode sections', () => {
    const catalog = createMockCatalog();
    const bundle = renderWikiBundle(catalog);

    // Home.md
    expect(bundle.home).toContain(
      '# My Project\n\nKnowledge graph overview for my project.',
    );
    expect(bundle.home).toContain('## Tutorials');
    expect(bundle.home).toContain(
      '- [Get Started](get-started): Beginner tutorial walkthrough.',
    );
    expect(bundle.home).toContain('## How-To Guides');
    expect(bundle.home).toContain(
      '- [Deploy App](deploy-app): Steps to deploy the app.',
    );
    expect(bundle.home).not.toContain('## Reference'); // reference has 0 docs
    expect(bundle.home).toContain('## Explanation');
    expect(bundle.home).toContain('- [Architecture](architecture)'); // empty firstParagraph has no colon
    expect(bundle.home).not.toContain('—'); // never an em dash

    // _Sidebar.md
    expect(bundle.sidebar).toContain('- [Home](Home)');
    expect(bundle.sidebar).toContain(
      '### Tutorials\n- [Get Started](get-started)',
    );
    expect(bundle.sidebar).toContain(
      '### How-To Guides\n- [Deploy App](deploy-app)',
    );
    expect(bundle.sidebar).not.toContain('### Reference');
    expect(bundle.sidebar).toContain(
      '### Explanation\n- [Architecture](architecture)',
    );

    // Pages ordered by slug
    const slugs = bundle.pages.map((p) => p.slug);
    expect(slugs).toEqual(['architecture', 'deploy-app', 'get-started']);
    for (const page of bundle.pages) {
      expect(page.fileName).toBe(`${page.slug}.md`);
      expect(page.content.endsWith('\n')).toBe(true);
    }
  });

  it('writes all files to output directory and returns sorted writtenFiles', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-render-write-'));
    const outputDir = join(tmp, 'wiki');

    try {
      const catalog = createMockCatalog();
      const bundle = renderWikiBundle(catalog);

      const result = await writeWikiBundle(outputDir, bundle);
      expect(result.writtenFiles).toEqual([
        'Home.md',
        '_Sidebar.md',
        'architecture.md',
        'deploy-app.md',
        'get-started.md',
      ]);

      expect(existsSync(join(outputDir, 'Home.md'))).toBe(true);
      expect(existsSync(join(outputDir, '_Sidebar.md'))).toBe(true);
      expect(existsSync(join(outputDir, 'deploy-app.md'))).toBe(true);

      const homeContent = readFileSync(join(outputDir, 'Home.md'), 'utf-8');
      expect(homeContent).toBe(bundle.home);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes stale top-level .md files when clean is true while preserving .git and non-md files', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-render-clean-'));
    const outputDir = join(tmp, 'wiki');
    mkdirSync(outputDir, { recursive: true });

    // Seed stale files and .git directory
    const gitDir = join(outputDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'config'), 'dummy git config');
    writeFileSync(join(outputDir, 'OldPage.md'), '# Old Page\n');
    writeFileSync(join(outputDir, 'custom.css'), '/* styles */');

    try {
      const catalog = createMockCatalog();
      const bundle = renderWikiBundle(catalog);

      const result = await writeWikiBundle(outputDir, bundle, { clean: true });
      expect(result.removedFiles).toEqual(['OldPage.md']);
      expect(existsSync(join(outputDir, 'OldPage.md'))).toBe(false);

      // Preserved files
      expect(existsSync(join(gitDir, 'config'))).toBe(true);
      expect(existsSync(join(outputDir, 'custom.css'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('protects freshly written files from case-insensitive clean deletion', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-render-clean-case-'));
    const outputDir = join(tmp, 'wiki');
    mkdirSync(outputDir, { recursive: true });

    // Seed a stale file
    writeFileSync(join(outputDir, 'stale-page.md'), '# Stale\n');

    try {
      const catalog = createMockCatalog();
      const bundle = renderWikiBundle(catalog);

      const result = await writeWikiBundle(outputDir, bundle, { clean: true });
      expect(result.removedFiles).toEqual(['stale-page.md']);
      expect(result.writtenFiles).toContain('Home.md');
      expect(result.writtenFiles).toContain('_Sidebar.md');
      expect(existsSync(join(outputDir, 'Home.md'))).toBe(true);
      expect(existsSync(join(outputDir, '_Sidebar.md'))).toBe(true);
      expect(existsSync(join(outputDir, 'stale-page.md'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses symlinked output directory or symlinked target file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lat-render-symlink-'));
    const realDir = join(tmp, 'real-wiki');
    const symlinkDir = join(tmp, 'symlink-wiki');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, symlinkDir, 'dir');

    try {
      const catalog = createMockCatalog();
      const bundle = renderWikiBundle(catalog);

      // Refuse symlinked outputDir
      await expect(writeWikiBundle(symlinkDir, bundle)).rejects.toThrow(
        /symbolic link/i,
      );

      // Refuse symlinked target file
      const targetFile = join(realDir, 'deploy-app.md');
      const dummyFile = join(tmp, 'dummy.md');
      writeFileSync(dummyFile, 'dummy');
      symlinkSync(dummyFile, targetFile);

      await expect(writeWikiBundle(realDir, bundle)).rejects.toThrow(
        /symbolic link/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
