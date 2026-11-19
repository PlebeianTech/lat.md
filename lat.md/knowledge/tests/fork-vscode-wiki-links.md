---
lat:
  require-code-mention: true
---

# Fork VS Code Wiki Links

Tests in [[packages/vscode-wiki-links/src/find-wiki-links.test.ts]] and [[packages/vscode-wiki-links/src/resolve-with-lat.test.ts]] for [[packages/vscode-wiki-links/src/find-wiki-links.ts]], which finds the wiki links the VS Code extension makes clickable, and [[packages/vscode-wiki-links/src/resolve-with-lat.ts]], which resolves a link target with `lat resolve`.

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

## Bracketed path in a comment link is found

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findCodeCommentLinks]] returns the whole path of `@lat: [[app/[[...slug]]/page.tsx]]`, because brackets inside a link body do not end the link.

## Bracketed path in a markdown link is found

[[packages/vscode-wiki-links/src/find-wiki-links.ts#findMarkdownLinks]] returns the whole path of links such as `[[app/[[...slug]]/page.tsx]]` and `[[src/pages/[region]]]`, with ranges that cover the full link.

## Resolved target gives file and line

[[packages/vscode-wiki-links/src/resolve-with-lat.ts#resolveWithLat]] returns the `file` and `line` that `lat resolve` prints as JSON on success. Tests in [[packages/vscode-wiki-links/src/resolve-with-lat.test.ts]] pass a fake `execFile`, so they run without VS Code.

## Error JSON gives its message

[[packages/vscode-wiki-links/src/resolve-with-lat.ts#resolveWithLat]] returns the `error` text from the JSON that `lat resolve` prints with exit code 1.

## Output without JSON falls back to stderr

[[packages/vscode-wiki-links/src/resolve-with-lat.ts#resolveWithLat]] uses the trimmed stderr as the error when stdout is empty or not JSON, as when lat finds no `lat.md/` directory.

## Spawn failure gives a readable error

[[packages/vscode-wiki-links/src/resolve-with-lat.ts#resolveWithLat]] names the binary in the error when the process cannot start, such as when `lat` is not found.

## CLI is called with the target after a double dash

[[packages/vscode-wiki-links/src/resolve-with-lat.ts#resolveWithLat]] runs the configured binary with `resolve`, `--` and the target, in the given directory, so a target that starts with `-` is not read as an option.
