import { readFile } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import type { Heading, Paragraph, Root, RootContent } from 'mdast';
import {
  listLatticeFiles,
  parseFrontmatter,
  parseSections,
  type Section,
} from '@plebeiantech/lat.md-core/lattice';
import { parse } from '@plebeiantech/lat.md-core/parser';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import {
  DIATAXIS_MODES,
  MODE_DIRS,
  type DiataxisMode,
  indexNameFor,
} from '@plebeiantech/lat.md-core/cli/check-mode';

export type WikiCatalogDoc = {
  mode: DiataxisMode;
  slug: string;
  title: string;
  firstParagraph: string;
  relPath: string;
  filePath: string;
  body: string;
  sections: Section[];
};

export type WikiCatalog = {
  latDir: string;
  projectRoot: string;
  rootTitle?: string;
  rootOverview?: string;
  docs: WikiCatalogDoc[];
  allSections: Section[];
};

const DIR_TO_MODE: Record<string, DiataxisMode> = Object.create(null);
for (const mode of DIATAXIS_MODES) {
  DIR_TO_MODE[MODE_DIRS[mode]] = mode;
}

const RESERVED_SLUGS = new Set(['home', '_sidebar', '_footer']);

function headingToText(node: Heading): string {
  function collect(children: RootContent[]): string {
    let result = '';
    for (const c of children) {
      if ('value' in c && typeof (c as { value: unknown }).value === 'string') {
        result += (c as { value: string }).value;
      } else if (
        'children' in c &&
        Array.isArray((c as { children: RootContent[] }).children)
      ) {
        result += collect((c as { children: RootContent[] }).children);
      }
    }
    return result;
  }
  return collect(node.children).trim();
}

function isBadgeOrImageParagraph(node: Paragraph): boolean {
  if (!node.children || node.children.length === 0) return true;
  for (const child of node.children) {
    if (child.type === 'image') continue;
    if (child.type === 'link') {
      const link = child as { type: string; children?: RootContent[] };
      const allImageOrEmpty =
        link.children?.every(
          (c) =>
            c.type === 'image' ||
            (c.type === 'text' &&
              typeof c.value === 'string' &&
              c.value.trim() === ''),
        ) ?? false;
      if (allImageOrEmpty) continue;
    }
    if (
      child.type === 'text' &&
      typeof child.value === 'string' &&
      child.value.trim() === ''
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function extractParagraphText(content: string, node: Paragraph): string {
  if (
    node.position?.start?.offset != null &&
    node.position?.end?.offset != null
  ) {
    return content
      .slice(node.position.start.offset, node.position.end.offset)
      .replace(/\r?\n\s*/g, ' ')
      .trim();
  }
  return '';
}

export async function buildWikiCatalog(
  latDir: string,
  projectRoot = dirname(latDir),
): Promise<WikiCatalog> {
  const files = await listLatticeFiles(latDir);
  const allSections: Section[] = [];

  type RawDocCandidate = {
    file: string;
    relPath: string;
    filePath: string;
    content: string;
    tree: Root;
    sections: Section[];
    mode: DiataxisMode;
    body: string;
    title: string;
    firstParagraph: string;
  };

  const rawDocs: RawDocCandidate[] = [];
  let rootTitle: string | undefined;
  let rootOverview: string | undefined;

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const tree = parse(content);
    const sections = parseSections(file, content, projectRoot, tree);
    allSections.push(...sections);

    const relPath = toPosix(relative(latDir, file));
    const filePath = toPosix(relative(projectRoot, file));
    const segments = relPath.split('/');
    const fileName = segments.pop()!;
    const holder = segments.length === 0 ? basename(latDir) : segments.at(-1)!;
    const isIndex = fileName === indexNameFor(holder);

    // Root index extraction
    if (isIndex && segments.length === 0) {
      // Find first H1 heading
      let h1Node: Heading | undefined;
      for (const node of tree.children) {
        if (node.type === 'heading' && node.depth === 1) {
          h1Node = node;
          break;
        }
      }

      if (h1Node) {
        rootTitle = headingToText(h1Node);
        const h1Index = tree.children.indexOf(h1Node);
        for (let i = h1Index + 1; i < tree.children.length; i++) {
          const node = tree.children[i];
          if (node.type === 'heading') break;
          if (node.type === 'paragraph' && !isBadgeOrImageParagraph(node)) {
            rootOverview = extractParagraphText(content, node);
            break;
          }
        }
      } else {
        rootTitle = undefined;
        for (const node of tree.children) {
          if (node.type === 'heading') break;
          if (node.type === 'paragraph' && !isBadgeOrImageParagraph(node)) {
            rootOverview = extractParagraphText(content, node);
            break;
          }
        }
      }
      continue;
    }

    // Exclude other directory indexes
    if (isIndex) continue;

    const fm = parseFrontmatter(content);
    if (
      fm.requireCodeMention === true ||
      fm.raw['require-code-mention'] === true
    ) {
      continue;
    }

    const firstSegment = relPath.split('/')[0];
    const dirMode =
      firstSegment && firstSegment !== relPath
        ? DIR_TO_MODE[firstSegment]
        : undefined;

    const declaredRaw = fm.raw['mode'];
    const hasDeclared = declaredRaw !== null && declaredRaw !== undefined;
    const declaredValid =
      typeof declaredRaw === 'string' &&
      (DIATAXIS_MODES as readonly string[]).includes(declaredRaw);

    if (hasDeclared && !declaredValid) {
      continue;
    }

    const declared = declaredValid ? (declaredRaw as DiataxisMode) : undefined;
    if (declared && dirMode && declared !== dirMode) {
      continue;
    }

    const resolvedMode = declared ?? dirMode;
    if (!resolvedMode) continue;

    // Body with stripped frontmatter
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

    // Title: first H1 heading text, falling back to file stem
    let title: string | undefined;
    for (const s of sections) {
      if (s.depth === 1) {
        title = s.heading;
        break;
      }
    }
    const stem = basename(file, '.md');
    if (!title) title = stem;

    // First paragraph
    let firstParagraph = '';
    const firstHeadingIndex = tree.children.findIndex(
      (n) => n.type === 'heading',
    );
    if (firstHeadingIndex >= 0) {
      for (let i = firstHeadingIndex + 1; i < tree.children.length; i++) {
        const node = tree.children[i];
        if (node.type === 'heading') break;
        if (node.type === 'paragraph') {
          firstParagraph = extractParagraphText(content, node);
          break;
        }
      }
    } else {
      const firstP = tree.children.find((n) => n.type === 'paragraph') as
        | Paragraph
        | undefined;
      if (firstP) {
        firstParagraph = extractParagraphText(content, firstP);
      }
    }
    if (!firstParagraph && sections.length > 0 && sections[0].firstParagraph) {
      firstParagraph = sections[0].firstParagraph;
    }

    rawDocs.push({
      file,
      relPath,
      filePath,
      content,
      tree,
      sections,
      mode: resolvedMode,
      body,
      title,
      firstParagraph,
    });
  }

  // Sort docs deterministically by relPath
  rawDocs.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Slug assignment with collision and reserved name handling
  const stemCounts = new Map<string, number>();
  for (const doc of rawDocs) {
    const stem = basename(doc.relPath, '.md').toLowerCase();
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  // Pre-calculate candidate slugs
  type SlugCandidate = {
    doc: RawDocCandidate;
    stem: string;
    modeSlug: string;
    dirSlug: string;
  };

  const candidates: SlugCandidate[] = rawDocs.map((doc) => {
    const stem = basename(doc.relPath, '.md');
    const modeSlug = `${doc.mode}-${stem}`;
    const relDir = dirname(doc.relPath);
    const dirPrefix = relDir === '.' ? '' : relDir.replace(/\//g, '-');
    const dirSlug = dirPrefix ? `${dirPrefix}-${stem}` : modeSlug;
    return { doc, stem, modeSlug, dirSlug };
  });

  // Check which initial slugs collide or are reserved
  const candidateModeCounts = new Map<string, number>();
  for (const c of candidates) {
    candidateModeCounts.set(
      c.modeSlug.toLowerCase(),
      (candidateModeCounts.get(c.modeSlug.toLowerCase()) ?? 0) + 1,
    );
  }

  const assignedDocs: WikiCatalogDoc[] = [];
  const usedSlugs = new Set<string>();

  for (const c of candidates) {
    const lowerStem = c.stem.toLowerCase();
    const isReserved = RESERVED_SLUGS.has(lowerStem);
    const hasStemCollision = (stemCounts.get(lowerStem) ?? 0) > 1;

    let slug: string;
    if (isReserved || hasStemCollision) {
      const modeCollides =
        (candidateModeCounts.get(c.modeSlug.toLowerCase()) ?? 0) > 1;
      if (modeCollides && c.dirSlug !== c.modeSlug) {
        slug = c.dirSlug;
      } else {
        slug = c.modeSlug;
      }
    } else {
      slug = c.stem;
    }

    // Ensure no accidental collision with already assigned slug
    let finalSlug = slug;
    let suffix = 2;
    while (usedSlugs.has(finalSlug.toLowerCase())) {
      finalSlug = `${slug}-${suffix++}`;
    }
    usedSlugs.add(finalSlug.toLowerCase());

    assignedDocs.push({
      mode: c.doc.mode,
      slug: finalSlug,
      title: c.doc.title,
      firstParagraph: c.doc.firstParagraph,
      relPath: c.doc.relPath,
      filePath: c.doc.filePath,
      body: c.doc.body,
      sections: c.doc.sections,
    });
  }

  return {
    latDir,
    projectRoot,
    rootTitle,
    rootOverview,
    docs: assignedDocs,
    allSections,
  };
}
