import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Root, RootContent } from 'mdast';
import {
  buildFileIndex,
  buildSectionSlugIndex,
  flattenSections,
  resolveRef,
  type Section,
} from '@plebeiantech/lat.md-core/lattice';
import {
  inspectRepositoryPath,
  normalizeRepositoryPath,
} from '@plebeiantech/lat.md-core/repository-path';
import {
  resolveSourceSymbol,
  type SourceSymbol,
} from '@plebeiantech/lat.md-core/source-parser';
import { isSourceFilePath } from '@plebeiantech/lat.md-core/source-formats';
import { parse } from '@plebeiantech/lat.md-core/parser';
import { toPosix } from '@plebeiantech/lat.md-core/path';
import type { WikiCatalog, WikiCatalogDoc } from './catalog.js';

export type WikiTransformOptions = {
  repoUrl?: string;
  ref?: string;
};

type AstTargetNode = {
  type: 'wikiLink' | 'link';
  value?: string;
  data?: { alias?: string | null };
  url?: string;
  children?: RootContent[];
  position: {
    start: { offset: number };
    end: { offset: number };
  };
};

function collectTargetNodes(
  node: RootContent | Root,
  list: AstTargetNode[],
): void {
  if (
    (node.type === 'wikiLink' || node.type === 'link') &&
    node.position?.start?.offset != null &&
    node.position?.end?.offset != null
  ) {
    list.push(node as unknown as AstTargetNode);
    return;
  }
  if (
    'children' in node &&
    Array.isArray((node as { children: RootContent[] }).children)
  ) {
    for (const child of (node as { children: RootContent[] }).children) {
      collectTargetNodes(child, list);
    }
  }
}

type Replacement = {
  start: number;
  end: number;
  replacement: string;
};

type TransformContext = {
  catalog: WikiCatalog;
  options?: WikiTransformOptions;
  sectionIds: Set<string>;
  sectionByLowerId: Map<string, Section>;
  fileIndex: Map<string, string[]>;
  slugIndex: Map<string, string>;
  docByFilePath: Map<string, WikiCatalogDoc>;
  docByRelPath: Map<string, WikiCatalogDoc>;
};

async function rewriteText(
  text: string,
  baseDir: string,
  ctx: TransformContext,
): Promise<string> {
  if (!text) return text;
  const tree = parse(text);
  const nodes: AstTargetNode[] = [];
  collectTargetNodes(tree, nodes);

  if (nodes.length === 0) return text;

  const repoUrl = ctx.options?.repoUrl?.replace(/\/+$/, '');
  const ref = ctx.options?.ref ?? 'HEAD';

  const replacements: Replacement[] = [];

  for (const node of nodes) {
    const start = node.position.start.offset;
    const end = node.position.end.offset;

    if (node.type === 'wikiLink') {
      const target = (node.value ?? '').trim();
      const alias = node.data?.alias ? node.data.alias.trim() : undefined;

      // 1. Try to resolve as Markdown section
      const refResult = resolveRef(
        target,
        ctx.sectionIds,
        ctx.fileIndex,
        ctx.slugIndex,
      );
      const section = refResult?.resolved
        ? ctx.sectionByLowerId.get(refResult.resolved.toLowerCase())
        : undefined;

      if (section) {
        const doc = ctx.docByFilePath.get(section.filePath);
        const label = alias ?? section.heading;

        if (doc) {
          // Exported Diataxis section link
          const dest =
            section.depth === 1
              ? doc.slug
              : `${doc.slug}#${section.githubSlug}`;
          replacements.push({ start, end, replacement: `[${label}](${dest})` });
        } else {
          // Non-exported lat.md section link
          if (repoUrl) {
            const frag = section.githubSlug ? `#${section.githubSlug}` : '';
            replacements.push({
              start,
              end,
              replacement: `[${label}](${repoUrl}/blob/${ref}/${section.filePath}${frag})`,
            });
          } else {
            replacements.push({ start, end, replacement: label });
          }
        }
        continue;
      }

      // 2. Source code and repository path link
      const hashIdx = target.indexOf('#');
      const filePart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
      const symbolPath = hashIdx >= 0 ? target.slice(hashIdx + 1) : undefined;

      const normalizedPath = normalizeRepositoryPath(filePart);
      if (!normalizedPath) {
        replacements.push({ start, end, replacement: alias ?? target });
        continue;
      }

      const inspected = await inspectRepositoryPath(
        ctx.catalog.projectRoot,
        normalizedPath,
      );

      if (inspected.kind !== 'file' && inspected.kind !== 'directory') {
        replacements.push({ start, end, replacement: alias ?? target });
        continue;
      }

      const label: string = alias ?? (symbolPath || normalizedPath);

      if (symbolPath && isSourceFilePath(normalizedPath)) {
        const symbolResult = await resolveSourceSymbol(
          normalizedPath,
          symbolPath,
          ctx.catalog.projectRoot,
          { latDir: ctx.catalog.latDir },
        );
        const parts = symbolPath.split('#');
        let symbol: SourceSymbol | undefined;
        if (parts.length === 1) {
          symbol = symbolResult.symbols.find(
            (s) => s.name === parts[0] && !s.parent,
          );
        } else if (parts.length === 2) {
          symbol = symbolResult.symbols.find(
            (s) => s.name === parts[1] && s.parent === parts[0],
          );
        }

        if (symbol) {
          const lineFrag =
            symbol.startLine === symbol.endLine
              ? `#L${symbol.startLine}`
              : `#L${symbol.startLine}-L${symbol.endLine}`;
          if (repoUrl) {
            replacements.push({
              start,
              end,
              replacement: `[${label}](${repoUrl}/blob/${ref}/${normalizedPath}${lineFrag})`,
            });
          } else {
            replacements.push({ start, end, replacement: label });
          }
        } else {
          if (repoUrl) {
            replacements.push({
              start,
              end,
              replacement: `[${label}](${repoUrl}/blob/${ref}/${normalizedPath})`,
            });
          } else {
            replacements.push({ start, end, replacement: label });
          }
        }
      } else {
        const action = inspected.kind === 'directory' ? 'tree' : 'blob';
        if (repoUrl) {
          replacements.push({
            start,
            end,
            replacement: `[${label}](${repoUrl}/${action}/${ref}/${normalizedPath})`,
          });
        } else {
          replacements.push({ start, end, replacement: label });
        }
      }
    } else if (node.type === 'link') {
      const url = node.url ?? '';
      // Skip same-page anchors and external URLs
      if (
        url.startsWith('#') ||
        url.startsWith('http://') ||
        url.startsWith('https://') ||
        url.startsWith('mailto:') ||
        url.startsWith('tel:')
      ) {
        continue;
      }

      // Extract inner label text
      let label = '';
      if (node.children && node.children.length > 0) {
        const first = node.children[0];
        const last = node.children[node.children.length - 1];
        if (
          first.position?.start?.offset != null &&
          last.position?.end?.offset != null
        ) {
          label = text.slice(
            first.position.start.offset,
            last.position.end.offset,
          );
        }
      }

      const hashIdx = url.indexOf('#');
      const pathPart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      const frag = hashIdx >= 0 ? url.slice(hashIdx) : '';

      const resolvedPath = resolve(baseDir, pathPart);
      const relToRoot = relative(ctx.catalog.projectRoot, resolvedPath);
      const isInsideRoot =
        !relToRoot.startsWith('..') && !isAbsolute(relToRoot);

      if (!isInsideRoot) {
        // Prevent path traversal escape: do not rewrite links escaping project root
        continue;
      }

      const repoRelPath = toPosix(relToRoot);

      const doc =
        ctx.docByFilePath.get(repoRelPath) ??
        ctx.docByFilePath.get(repoRelPath + '.md');

      if (doc) {
        replacements.push({
          start,
          end,
          replacement: `[${label}](${doc.slug}${frag})`,
        });
      } else if (existsSync(resolvedPath)) {
        let isDir = false;
        try {
          isDir = statSync(resolvedPath).isDirectory();
        } catch {
          // ignore
        }
        const action = isDir ? 'tree' : 'blob';
        if (repoUrl) {
          replacements.push({
            start,
            end,
            replacement: `[${label}](${repoUrl}/${action}/${ref}/${repoRelPath}${frag})`,
          });
        } else {
          replacements.push({ start, end, replacement: label });
        }
      }
    }
  }

  // Apply replacements in reverse order of appearance
  replacements.sort((a, b) => b.start - a.start);
  let result = text;
  for (const rep of replacements) {
    result =
      result.slice(0, rep.start) + rep.replacement + result.slice(rep.end);
  }

  return result;
}

function createTransformContext(
  catalog: WikiCatalog,
  options?: WikiTransformOptions,
): TransformContext {
  const flat = flattenSections(catalog.allSections);
  const sectionIds = new Set(flat.map((s) => s.id.toLowerCase()));
  const sectionByLowerId = new Map(flat.map((s) => [s.id.toLowerCase(), s]));
  const fileIndex = buildFileIndex(catalog.allSections);
  const slugIndex = buildSectionSlugIndex(catalog.allSections);
  const docByFilePath = new Map(catalog.docs.map((d) => [d.filePath, d]));
  const docByRelPath = new Map(catalog.docs.map((d) => [d.relPath, d]));

  return {
    catalog,
    options,
    sectionIds,
    sectionByLowerId,
    fileIndex,
    slugIndex,
    docByFilePath,
    docByRelPath,
  };
}

export async function transformWikiDocument(
  doc: WikiCatalogDoc,
  catalog: WikiCatalog,
  options?: WikiTransformOptions,
): Promise<WikiCatalogDoc> {
  const ctx = createTransformContext(catalog, options);
  const baseDir = resolve(catalog.projectRoot, dirname(doc.filePath));

  const [body, firstParagraph] = await Promise.all([
    rewriteText(doc.body, baseDir, ctx),
    rewriteText(doc.firstParagraph, baseDir, ctx),
  ]);

  return {
    ...doc,
    body,
    firstParagraph,
  };
}

export async function transformWikiCatalog(
  catalog: WikiCatalog,
  options?: WikiTransformOptions,
): Promise<WikiCatalog> {
  const ctx = createTransformContext(catalog, options);

  const transformedDocs = await Promise.all(
    catalog.docs.map(async (doc) => {
      const baseDir = resolve(catalog.projectRoot, dirname(doc.filePath));
      const [body, firstParagraph] = await Promise.all([
        rewriteText(doc.body, baseDir, ctx),
        rewriteText(doc.firstParagraph, baseDir, ctx),
      ]);
      return {
        ...doc,
        body,
        firstParagraph,
      };
    }),
  );

  let rootOverview = catalog.rootOverview;
  if (rootOverview) {
    rootOverview = await rewriteText(rootOverview, catalog.latDir, ctx);
  }

  return {
    ...catalog,
    rootOverview,
    docs: transformedDocs,
  };
}
