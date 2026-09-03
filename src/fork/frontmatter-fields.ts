/**
 * The fork's frontmatter surface, kept out of upstream's type module so a
 * field added later costs one edit here instead of two upstream.
 *
 * Upstream reads `require-code-mention` out of the block with a regex and asks
 * nothing else of it. This fork parses the block as YAML and hands the whole
 * `lat:` mapping to its own checks, which means it also has to report the two
 * ways that parse can go wrong.
 */

/**
 * Every field this build reads out of the `lat:` mapping. Kept in one place so
 * a field added later is covered by the misplacement check without a second
 * edit — the trap this list guards against is silent, so it must not depend on
 * whoever adds the next field remembering to register it twice.
 */
export const LAT_FIELDS = [
  'require-code-mention',
  'mode',
  'require-mode',
  'status',
  'reviewed-hash',
  'tags',
] as const;

/**
 * Something wrong with the frontmatter itself, carried out of the parser for a
 * caller to report. Both kinds fail OPEN if they stay quiet: a misplaced or
 * unparseable `require-code-mention` turns a validation off and `lat check`
 * then reports success on a file that is no longer being validated.
 */
export type FrontmatterProblem =
  | { kind: 'root-level-field'; field: string }
  | { kind: 'parse-error'; message: string };

/** Mixed into upstream's `LatFrontmatter` rather than replacing it. */
export type ForkFrontmatter = {
  /** Every key under the `lat:` mapping, parsed but not mapped to a field. */
  raw: Record<string, unknown>;
  /** Populated only when something is wrong; absent on a healthy document. */
  problems?: FrontmatterProblem[];
};
