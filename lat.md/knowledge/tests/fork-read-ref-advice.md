---
lat:
  require-code-mention: true
---

# Fork Read Ref Advice

Tests in [[tests/fork-read-ref-advice.test.ts]] for [[src/fork/read-ref-advice.ts#buildReadRefAdvice]], which turns the `@lat:` references in a range of lines an agent read into advice to query lat. The advice names section ids and commands only, never section text.

Each test writes source files into a temporary project with a `lat.md/` directory. Session tests use a fresh random session id, so markers from earlier runs cannot affect them.

## References in the range are advised

A source file holds `// @lat: [[auth#OAuth Flow]]` and `# @lat: [[cli#hook]]`. The advice names both targets in `lat section "TARGET"` and `lat refs "TARGET"` commands and mentions the `lat_section` MCP tool. The text of the `auth#OAuth Flow` section does not appear.

## References outside the range are ignored

Three lines each hold one reference. A read of line 2 only advises the reference on line 2.

## An alias is cut from the target

`// @lat: [[cli#hook|the hook]]` is advised as `cli#hook`, because `lat section` cannot resolve a target that keeps its alias.

## A Markdown file returns null

A `.md` file that holds `// @lat: [[a#b]]` returns null, because only source files carry code references.

## Targets unsafe in a shell command are left out

`// @lat: [[a$(touch pwned)b]]` and `# @lat: [[x" && touch pwned && echo "y]]` are left out of the advice, and a safe target on the next line is still advised. The advice puts each target inside a suggested shell command, so a target may hold only letters, digits, spaces and `#/._-,:()'`.

## Each target is advised once per session

A second read in the same session returns null. A different session id gets the advice again. Without a session id, every read advises.

## Advice names at most five targets

Seven distinct targets produce advice that names the first 5 and states that 2 more were found. A second read in the same session names the other 2 and no longer mentions more.

## Control characters are cleaned from a target

A target holding U+0007 is advised with a space in place of the control character.

## Unusable files return null

A missing file, a file outside the project root and a source file under `lat.md/` each return null without throwing.
