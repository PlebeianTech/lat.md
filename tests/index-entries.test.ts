import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { checkIndex } from '../src/cli/check.js';

const casesDir = join(import.meta.dirname, 'cases');

function latDir(name: string): string {
  return join(casesDir, name, 'lat.md');
}

// lat-t1y.39: an external link in a directory index bullet must not be
// misparsed as a generated index entry (the URL scheme was being taken as
// the entry name, e.g. "https:" from "https://example.com/docs").
describe('index-entries: external links vs generated/wiki entries', () => {
  // @lat: [[check-index#Directory index entry parsing#External link bullets are ignored]]
  it('does not treat an external-link bullet as a generated index entry', async () => {
    const errors = await checkIndex(latDir('index-entries-mixed'));
    expect(errors).toHaveLength(0);
  });

  // @lat: [[check-index#Directory index entry parsing#Generated and legacy wiki-link entries still validate]]
  it('still validates a genuine generated entry and a legacy wiki-link entry', async () => {
    // index-entries-mixed also contains `- [Notes](notes.md)` (generated
    // form) and `- [[page]]` (legacy wiki-link form); both files exist on
    // disk. If either parse path regressed, checkIndex would report a
    // missing or stale entry here.
    const errors = await checkIndex(latDir('index-entries-mixed'));
    expect(errors).toHaveLength(0);
  });

  // @lat: [[check-index#Directory index entry parsing#A bare scheme-shaped filename is treated as external]]
  it('treats a bare scheme-shaped filename as external, not local', async () => {
    // `weird:name.md` matches the URL-scheme grammar (a leading identifier
    // followed by `:`) even though it has no `/` before the colon, so on its
    // own it is genuinely ambiguous between "a URL with an unusual scheme"
    // and "a relative path that happens to contain a colon". We deliberately
    // resolve that ambiguity by reusing the exact same `hasUrlScheme` rule
    // that `localLinkTarget` already applies for relative-link validation
    // elsewhere in this file (see link-scheme.ts) rather than inventing a
    // second, different heuristic (e.g. requiring a `/` before the `:`).
    // Consistency between the two call sites matters more than getting this
    // single edge case to lean the other way: this bullet is therefore
    // skipped as an external link, and checkIndex reports no error even
    // though no file named "weird:name.md" exists on disk.
    const errors = await checkIndex(latDir('index-entries-ambiguous-colon'));
    expect(errors).toHaveLength(0);
  });

  // @lat: [[check-index#Directory index entry parsing#Destination shapes that are not child names]]
  it('resolves dot-relative and fragment destinations, and ignores escaping ones', async () => {
    // The first path segment of a destination is not automatically a child
    // name. Before this was handled, this fixture produced five errors:
    // "notes" and "page" reported missing, and three bogus stale entries
    // named ".", "..", and "page.md#intro".
    //
    // `../outside.md` is a deliberately dangling relative link. The point is
    // that a destination leaving this directory names no child of it, so the
    // index parser must ignore it rather than invent an entry called "..";
    // whether the target exists is `check links`' question, not this one.
    //
    // `%2e%2e/outside.md` is the same escape spelled with percent-encoding
    // (lat-t1y.32 follow-up): the traversal check must fire after decoding
    // too, or this bullet would produce a bogus stale entry named "..".
    const errors = await checkIndex(latDir('index-entries-dest-shapes'));
    expect(errors).toHaveLength(0);
  });
});
