/**
 * Decide whether a Markdown link destination points inside the lattice or
 * out at the wider world.
 *
 * This exists as its own module because two callers need the same answer and
 * a second, differently-behaved copy of the rule is exactly how the two
 * drift: `parseIndexEntries` in check.ts decides which index bullets are
 * generated entries, and `spliceIndexContent` in gen-index.ts decides which
 * bullets belong to the region `--fix` is allowed to rewrite. If those two
 * ever disagree about a line, `--fix` rewrites a bullet the checker does not
 * track, or leaves one it does.
 *
 * `localLinkTarget` in check.ts applies the same rule inline for
 * relative-link validation. It is upstream code and is deliberately left
 * alone here; if this ever moves upstream, that is the call site to fold in.
 */

/**
 * True when `url` carries a URL scheme (`https:`, `mailto:`, `file:`) and is
 * therefore not a path inside the lattice.
 *
 * A Windows drive letter is the one case that looks like a scheme and is not
 * — `C:\docs\a.md` matches the scheme grammar because a drive letter is a
 * single ASCII letter followed by a colon. Treat it as a path, the same way
 * `localLinkTarget` does, so the two agree.
 */
export function hasUrlScheme(url: string): boolean {
  const u = url.trim();
  if (/^[a-zA-Z]:\\/.test(u)) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u);
}

/**
 * True when `url` is a destination the lattice can own: no scheme, and not
 * rooted at the filesystem root. A root-absolute path is excluded for the
 * same reason `localLinkTarget` excludes it — it names a location outside
 * the lattice tree, so it is never a child entry of a directory index.
 */
export function isLatticeLocalDest(url: string): boolean {
  const u = url.trim();
  if (u === '') return false;
  if (u.startsWith('/')) return false;
  return !hasUrlScheme(u);
}

/**
 * Reduce a Markdown link destination to the name of the directory child it
 * refers to, or null when it refers to no child of this directory at all.
 *
 * The naive reading — take the first `/`-separated segment — is wrong in
 * four distinct ways, and each one was observed producing a bogus entry
 * name that `lat check` then reported as a stale entry that "does not
 * exist":
 *
 *   https://example.com/docs  ->  "https:"   a scheme is not a path segment
 *   ./notes.md                ->  "."        a no-op prefix is not a child
 *   ../siblings/x.md          ->  ".."       this escapes the directory
 *   notes.md#intro            ->  "notes.md#intro"  fragments are not names
 *
 * Order is load-bearing. The fragment and query are split off BEFORE
 * percent-decoding, and the path is split on `/` BEFORE decoding too, for
 * the same reason `localLinkTarget` does it: `%23` and `%2F` decode to `#`
 * and `/`, and decoding first would let a filename that legitimately
 * contains either one truncate or split itself.
 */
export function indexEntryNameFromDest(dest: string): string | null {
  if (!isLatticeLocalDest(dest)) return null;

  const u = dest.trim();

  const queryAt = u.indexOf('?');
  const fragmentAt = u.indexOf('#');
  const pathEnd = Math.min(
    queryAt === -1 ? u.length : queryAt,
    fragmentAt === -1 ? u.length : fragmentAt,
  );
  let path = u.slice(0, pathEnd);

  // `./` contributes nothing to the path, and may be repeated.
  while (path.startsWith('./')) path = path.slice(2);

  // `..` leaves the directory whose index this is, so whatever it names is
  // by definition not a child of it.
  if (path === '..' || path.startsWith('../')) return null;
  if (path === '' || path === '.') return null;

  const segment = path.split('/')[0];
  if (segment === '') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }

  // A percent-encoded `.` or `..` (e.g. `%2e%2e`) decodes to the same
  // traversal segment the raw check above already rejects. Re-check after
  // decoding so both spellings agree — this is a consistency fix, not a
  // security one: parseIndexEntries only compares names, it never builds a
  // filesystem path from one.
  if (decoded === '.' || decoded === '..') return null;

  return decoded;
}
