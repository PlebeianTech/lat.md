/**
 * The Stop hook reminder used when `lat check` found no errors but the code
 * changes are large compared with the `lat.md/` changes.
 */
export function stopSyncMessage(
  codeLines: number,
  latMdLines: number,
  hasSections: boolean,
): string {
  const changes =
    latMdLines === 0
      ? `The codebase has changes (${codeLines} lines) but \`lat.md/\` was not updated.`
      : `The codebase has changes (${codeLines} lines) but \`lat.md/\` may not be fully in sync (${latMdLines} lines changed).`;

  const noCheckErrors =
    'The hook found no `lat check` errors. This reminder is separate from `lat check`, and `lat check` cannot clear it.';

  const whatClearsIt = hasSections
    ? 'Edit each section listed below that the code change makes wrong. Once you have edited every listed section, the reminder clears.'
    : 'Run `lat search` to find the sections that the code change makes wrong, and edit them. Keep `lat.md/` focused on current state. Do not add journal or changelog notes.';

  const shownOnce = hasSections
    ? 'This reminder is shown once for these code changes. If no listed section needs a change, you may finish.'
    : 'This reminder is shown once for these code changes. If no section needs a change, you may finish.';

  return [changes, noCheckErrors, whatClearsIt, shownOnce].join(' ');
}
