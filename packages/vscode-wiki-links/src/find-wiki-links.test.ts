import { describe, it, expect } from 'vitest';
import { findCodeCommentLinks, findMarkdownLinks } from './find-wiki-links.js';

describe('findCodeCommentLinks', () => {
  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Slash comment link is found]]
  it('finds a link in a // comment', () => {
    const text = 'const a = 1; // @lat: [[src/a#fn]]';
    expect(findCodeCommentLinks(text)).toEqual([
      { target: 'src/a#fn', start: 22, end: 34 },
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Hash comment link is found]]
  it('finds a link in a # comment', () => {
    const text = '# @lat:\t[[notes#Intro]]';
    expect(findCodeCommentLinks(text)).toEqual([
      { target: 'notes#Intro', start: 8, end: 23 },
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Two markers on one line give two links]]
  it('finds one link per marker on the same line', () => {
    const text = '// @lat: [[a]] // @lat: [[b]]';
    expect(findCodeCommentLinks(text).map((link) => link.target)).toEqual([
      'a',
      'b',
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Link without its own marker is ignored]]
  it('ignores a later link that has no marker of its own', () => {
    const text = '// @lat: [[a]], [[b]]';
    expect(findCodeCommentLinks(text).map((link) => link.target)).toEqual([
      'a',
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Alias is removed from the target]]
  it('removes the alias from the target but keeps it in the range', () => {
    const text = '// @lat: [[a#b|label]]';
    expect(findCodeCommentLinks(text)).toEqual([
      { target: 'a#b', start: 9, end: 22 },
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Offsets are relative to the whole text]]
  it('reports offsets into the whole text for a link on the second line', () => {
    const text = 'first line\n// @lat: [[x]]';
    const [link] = findCodeCommentLinks(text);
    expect(link).toEqual({ target: 'x', start: 20, end: 25 });
    expect(text.slice(link.start, link.end)).toBe('[[x]]');
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Link outside an at-lat comment is ignored]]
  it('ignores a [[...]] that is not in an @lat: comment', () => {
    const text = 'const a = [[1]]; // see [[b]]';
    expect(findCodeCommentLinks(text)).toEqual([]);
  });
});

describe('findMarkdownLinks', () => {
  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Markdown link outside a fence is found]]
  it('finds links in ordinary text', () => {
    const text = 'See [[a#b]] and [[c|d]].';
    expect(findMarkdownLinks(text)).toEqual([
      { target: 'a#b', start: 4, end: 11 },
      { target: 'c', start: 16, end: 23 },
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Markdown link inside a fence is ignored]]
  it('ignores links inside a fenced code block', () => {
    const text = '```\n[[a]]\n```\n[[b]]';
    expect(findMarkdownLinks(text).map((link) => link.target)).toEqual(['b']);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Markdown link inside an indented fence is ignored]]
  it('ignores links inside an indented fence', () => {
    const text = '  ~~~md\n  [[a]]\n  ~~~\n[[b]]';
    expect(findMarkdownLinks(text).map((link) => link.target)).toEqual(['b']);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Backtick fence is not closed by a tilde line]]
  it('keeps a backtick fence open on a tilde line', () => {
    const text = '```\n~~~\n[[a]]\n```\n[[b]]';
    expect(findMarkdownLinks(text).map((link) => link.target)).toEqual(['b']);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Markdown link inside an inline code span is ignored]]
  it('ignores links inside an inline code span', () => {
    const text = 'Write `[[wiki links]]` as [[real]].';
    expect(findMarkdownLinks(text).map((link) => link.target)).toEqual([
      'real',
    ]);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Backslash-escaped opening brackets are ignored]]
  it('ignores a [[ preceded by a backslash', () => {
    const text = 'Escaped \\[[a]] but [[b]]';
    expect(findMarkdownLinks(text).map((link) => link.target)).toEqual(['b']);
  });
});
