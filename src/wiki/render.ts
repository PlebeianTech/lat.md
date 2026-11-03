import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { DiataxisMode } from '@plebeiantech/lat.md-core/cli/check-mode';
import type { WikiCatalog, WikiCatalogDoc } from './catalog.js';

export type WikiBundlePage = {
  slug: string;
  fileName: string;
  content: string;
};

export type WikiBundle = {
  home: string;
  sidebar: string;
  pages: WikiBundlePage[];
};

const MODE_ORDER: readonly DiataxisMode[] = [
  'tutorial',
  'how-to',
  'reference',
  'explanation',
] as const;

const MODE_HEADINGS: Record<DiataxisMode, { h2: string; h3: string }> = {
  tutorial: { h2: '## Tutorials', h3: '### Tutorials' },
  'how-to': { h2: '## How-To Guides', h3: '### How-To Guides' },
  reference: { h2: '## Reference', h3: '### Reference' },
  explanation: { h2: '## Explanation', h3: '### Explanation' },
};

function normalizeContent(content: string): string {
  return content.endsWith('\n') ? content : content + '\n';
}

export function renderWikiBundle(
  catalog: WikiCatalog,
  options?: { repoName?: string },
): WikiBundle {
  const rootTitle = catalog.rootTitle ?? options?.repoName ?? 'Documentation';

  // Group docs by mode
  const docsByMode = new Map<DiataxisMode, WikiCatalogDoc[]>();
  for (const mode of MODE_ORDER) {
    docsByMode.set(mode, []);
  }

  for (const doc of catalog.docs) {
    const list = docsByMode.get(doc.mode);
    if (list) {
      list.push(doc);
    }
  }

  // Sort docs within each mode by slug
  for (const list of docsByMode.values()) {
    list.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // 1. Home.md
  const homeParts: string[] = [];
  homeParts.push(`# ${rootTitle}`);
  if (catalog.rootOverview) {
    homeParts.push(catalog.rootOverview);
  }

  for (const mode of MODE_ORDER) {
    const docs = docsByMode.get(mode)!;
    if (docs.length === 0) continue;

    homeParts.push(MODE_HEADINGS[mode].h2);
    const lines = docs.map((doc) => {
      const summary = doc.firstParagraph ? `: ${doc.firstParagraph}` : '';
      return `- [${doc.title}](${doc.slug})${summary}`;
    });
    homeParts.push(lines.join('\n'));
  }
  const home = normalizeContent(homeParts.join('\n\n'));

  // 2. _Sidebar.md
  const sidebarParts: string[] = ['- [Home](Home)'];
  for (const mode of MODE_ORDER) {
    const docs = docsByMode.get(mode)!;
    if (docs.length === 0) continue;

    const lines = docs.map((doc) => `- [${doc.title}](${doc.slug})`);
    sidebarParts.push(`${MODE_HEADINGS[mode].h3}\n${lines.join('\n')}`);
  }
  const sidebar = normalizeContent(sidebarParts.join('\n\n'));

  // 3. Pages ordered by slug
  const sortedDocs = [...catalog.docs].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const pages: WikiBundlePage[] = sortedDocs.map((doc) => ({
    slug: doc.slug,
    fileName: `${doc.slug}.md`,
    content: normalizeContent(doc.body),
  }));

  return {
    home,
    sidebar,
    pages,
  };
}

async function verifyNoSymlinksInPath(targetPath: string): Promise<void> {
  const absPath = resolve(targetPath);
  const root = isAbsolute(absPath) ? resolve(sep) : '';
  const parts = absPath.slice(root.length).split(sep);

  let current = root;
  for (const part of parts) {
    if (!part) continue;
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        if (
          process.platform === 'darwin' &&
          (current === '/var' || current === '/tmp' || current === '/etc')
        ) {
          continue;
        }
        throw new Error(`Refusing to write to symbolic link path: ${current}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        break; // remaining path does not exist yet
      }
      throw err;
    }
  }
}

export async function writeWikiBundle(
  outputDir: string,
  bundle: WikiBundle,
  options?: { clean?: boolean },
): Promise<{ writtenFiles: string[]; removedFiles: string[] }> {
  const absOutputDir = resolve(outputDir);
  await verifyNoSymlinksInPath(absOutputDir);

  await mkdir(absOutputDir, { recursive: true });

  const filesToWrite: { fileName: string; content: string }[] = [
    { fileName: 'Home.md', content: bundle.home },
    { fileName: '_Sidebar.md', content: bundle.sidebar },
  ];

  for (const page of bundle.pages) {
    if (
      page.fileName.includes('/') ||
      page.fileName.includes('\\') ||
      page.fileName.includes('..') ||
      page.slug.includes('/') ||
      page.slug.includes('\\') ||
      page.slug.includes('..')
    ) {
      throw new Error(`Invalid page slug or fileName: ${page.fileName}`);
    }
    filesToWrite.push({ fileName: page.fileName, content: page.content });
  }

  const writtenSet = new Set<string>();
  const writtenFiles: string[] = [];

  for (const item of filesToWrite) {
    const filePath = resolve(absOutputDir, item.fileName);
    if (dirname(filePath) !== absOutputDir) {
      throw new Error(`Path traversal attempted: ${item.fileName}`);
    }

    try {
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symbolic link: ${filePath}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    await writeFile(filePath, item.content, 'utf-8');
    writtenSet.add(item.fileName);
    writtenFiles.push(item.fileName);
  }

  const removedFiles: string[] = [];

  if (options?.clean) {
    const writtenLower = new Set([...writtenSet].map((f) => f.toLowerCase()));
    const entries = await readdir(absOutputDir);
    for (const entry of entries) {
      if (
        entry.toLowerCase().endsWith('.md') &&
        !writtenLower.has(entry.toLowerCase())
      ) {
        const entryPath = join(absOutputDir, entry);
        await rm(entryPath, { force: true });
        removedFiles.push(entry);
      }
    }
  }

  writtenFiles.sort();
  removedFiles.sort();

  return {
    writtenFiles,
    removedFiles,
  };
}
