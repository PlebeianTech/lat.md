---
lat:
  require-code-mention: true
---

# Fork VS Code Wiki Links

Tests in [[packages/vscode-wiki-links/src/find-wiki-links.test.ts]] for [[packages/vscode-wiki-links/src/find-wiki-links.ts]], which finds the wiki links the VS Code extension makes clickable.

## Slash comment link is found

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] returns the link after a `//` marker followed by `@lat:`, with start and end covering `[[` to `]]`.

## Hash comment link is found

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] accepts a `#` marker and tabs between `@lat:` and the link.

## Two markers on one line give two links

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] returns one link for each marker on a line.

## Link without its own marker is ignored

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] returns only the first link in `@lat: [[a]], [[b]]`, because the second link has no marker before it.

## Alias is removed from the target

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] drops the `|label` suffix from `target` while `start` and `end` still cover the whole link.

## Offsets are relative to the whole text

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] reports offsets into the full text for a link on the second line.

## Link outside an at-lat comment is ignored

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] ignores a `[[...]]` in code, or in a comment without `@lat:`.

## Markdown link outside a fence is found

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] returns every `[[...]]` in ordinary text, with aliases removed from the target.

## Markdown link inside a fence is ignored

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] skips links between a fence opening line and the line that closes it.

## Markdown link inside an indented fence is ignored

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] treats a fence indented by spaces as a fence.

## Backtick fence is not closed by a tilde line

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] closes a fence only with the same character, so a tilde line inside a backtick fence leaves it open.

## Markdown link inside an inline code span is ignored

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] skips a `[[...]]` inside a backtick-delimited span but finds links outside it on the same line.

## Backslash-escaped opening brackets are ignored

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] does not return a `[[` preceded by a backslash.
