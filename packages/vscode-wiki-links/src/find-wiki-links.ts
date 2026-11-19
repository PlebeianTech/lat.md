export interface WikiLink {
  /** The text inside the brackets, without any `|label` alias. */
  target: string;
  /** Offset of the opening `[[`. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
}

const CODE_COMMENT_LINK =
  /(?<=(?:\/\/|#)[^\S\r\n]*@lat:[^\S\r\n]*)\[\[(.+?)\]\]/g;
const WIKI_LINK = /(?<!\\)\[\[(.+?)\]\]/g;
const FENCE_OPENING = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE_SPAN = /(`+).+?\1/g;

function toTarget(linkBody: string): string {
  return linkBody.split('|')[0];
}

function findLinks(pattern: RegExp, text: string, offset = 0): WikiLink[] {
  return [...text.matchAll(pattern)].map((match) => ({
    target: toTarget(match[1]),
    start: offset + match.index,
    end: offset + match.index + match[0].length,
  }));
}

/** Links in `@lat:` comments of a source file, one per comment marker. */
export function findCodeCommentLinks(text: string): WikiLink[] {
  return findLinks(CODE_COMMENT_LINK, text);
}

function blankOutInlineCode(line: string): string {
  return line.replace(INLINE_CODE_SPAN, (span) => ' '.repeat(span.length));
}

function closesFence(line: string, fence: string): boolean {
  const closing = line.trim();
  return (
    closing.length >= fence.length &&
    closing === fence[0].repeat(closing.length)
  );
}

/** Links in a markdown file, skipping fenced code, inline code and escaped `[[`. */
export function findMarkdownLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  let openFence: string | undefined;
  let lineStart = 0;
  for (const line of text.split('\n')) {
    if (openFence) {
      if (closesFence(line, openFence)) openFence = undefined;
    } else {
      openFence = FENCE_OPENING.exec(line)?.[1];
      if (!openFence) {
        links.push(
          ...findLinks(WIKI_LINK, blankOutInlineCode(line), lineStart),
        );
      }
    }
    lineStart += line.length + 1;
  }
  return links;
}
