import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findCodeCommentLinks, findMarkdownLinks } from './find-wiki-links.js';
import { resolveWithLat } from './resolve-with-lat.js';

// The extensions lat scans for @lat: comments: SOURCE_FILE_EXTENSIONS in
// packages/core/src/source-formats.ts.
const SOURCE_FILE_EXTENSIONS = [
  'c',
  'dart',
  'erb',
  'go',
  'h',
  'java',
  'js',
  'jsx',
  'php',
  'py',
  'rake',
  'rb',
  'rs',
  'swift',
  'ts',
  'tsx',
];

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', pattern: `**/*.{${SOURCE_FILE_EXTENSIONS.join(',')}}` },
  { scheme: 'file', pattern: '**/lat.md/**/*.md' },
];

class WikiLink extends vscode.DocumentLink {
  constructor(
    range: vscode.Range,
    readonly ref: string,
    readonly documentDirectory: string,
  ) {
    super(range);
  }
}

class WikiLinkProvider implements vscode.DocumentLinkProvider<WikiLink> {
  provideDocumentLinks(document: vscode.TextDocument): WikiLink[] {
    const text = document.getText();
    const links = document.fileName.endsWith('.md')
      ? findMarkdownLinks(text)
      : findCodeCommentLinks(text);
    const documentDirectory = path.dirname(document.uri.fsPath);
    return links.map((link) => {
      const range = new vscode.Range(
        document.positionAt(link.start),
        document.positionAt(link.end),
      );
      return new WikiLink(range, link.target, documentDirectory);
    });
  }

  async resolveDocumentLink(link: WikiLink): Promise<WikiLink> {
    const latPath = vscode.workspace
      .getConfiguration('latWikiLinks')
      .get<string>('latPath', 'lat');
    const result = await resolveWithLat(
      execFile,
      latPath,
      link.ref,
      link.documentDirectory,
    );
    if ('error' in result) {
      void vscode.window.showWarningMessage(result.error);
      return link;
    }
    link.target = vscode.Uri.file(result.file).with({
      fragment: `L${result.line}`,
    });
    return link;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      DOCUMENT_SELECTOR,
      new WikiLinkProvider(),
    ),
  );
}
