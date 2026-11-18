import { describe, it, expect } from 'vitest';
import { stopSyncMessage } from '../src/fork/stop-sync-message.js';
import { formatStopReason, type StopStatus } from '../src/cli/hook.js';

const syncOnly: StopStatus = {
  checkFailed: false,
  totalErrors: 0,
  needsSync: true,
  codeLines: 100,
  latMdLines: 0,
  impactedSections: ['cli#CLI#hook#Stop', 'tests/hook#Stop Hook'],
};

describe('stop sync message', () => {
  // @lat: [[fork-stop-sync-message#Fork Stop Sync Message#Does not tell the agent to run lat check]]
  it('does not tell the agent to run lat check', () => {
    for (const hasSections of [true, false]) {
      const message = stopSyncMessage(100, 0, hasSections);
      expect(message).not.toMatch(/run `?lat check/i);
      expect(message).not.toMatch(/lat check`? at the end/i);
      expect(message).toContain('The hook found no `lat check` errors.');
    }
  });

  // @lat: [[fork-stop-sync-message#Fork Stop Sync Message#Says editing the listed sections clears the reminder]]
  it('says editing the listed sections clears the reminder', () => {
    const reason = formatStopReason(syncOnly)!;
    expect(reason).toContain('Edit each section listed below');
    expect(reason).toContain('the reminder clears');
    expect(reason.match(/Sections linked to modified code:/g)).toHaveLength(1);
    expect(stopSyncMessage(100, 0, false)).not.toContain('listed below');
  });

  // @lat: [[fork-stop-sync-message#Fork Stop Sync Message#Says the reminder is shown once]]
  it('says the reminder is shown once for these code changes', () => {
    expect(stopSyncMessage(100, 0, true)).toContain(
      'This reminder is shown once for these code changes.',
    );
    expect(stopSyncMessage(100, 0, false)).toContain(
      'This reminder is shown once for these code changes.',
    );
  });

  // @lat: [[fork-stop-sync-message#Fork Stop Sync Message#Counts the lines]]
  it('states the line counts', () => {
    expect(stopSyncMessage(100, 0, true)).toContain(
      'The codebase has changes (100 lines) but `lat.md/` was not updated.',
    );
    expect(stopSyncMessage(100, 3, true)).toContain(
      'The codebase has changes (100 lines) but `lat.md/` may not be fully in sync (3 lines changed).',
    );
  });

  // @lat: [[fork-stop-sync-message#Fork Stop Sync Message#Keeps the check failed messages]]
  it('keeps the check failed messages unchanged', () => {
    const failed = { ...syncOnly, checkFailed: true, totalErrors: 2 };
    expect(formatStopReason({ ...failed, needsSync: false })).toBe(
      '`lat check` found 2 error(s). Run `lat check`, fix the errors, and repeat until it passes.',
    );
    expect(formatStopReason({ ...failed, impactedSections: [] })).toBe(
      [
        '`lat check` found errors. The codebase has changes (100 lines) but `lat.md/` was not updated. Before finishing:',
        '',
        '1. Update `lat.md/` where changes affect behavior, architecture, tests, or plans; keep it focused on current state rather than journal/changelog notes.',
        '2. Run `lat check` until it passes.',
      ].join('\n'),
    );
    expect(
      formatStopReason({ ...failed, latMdLines: 4, impactedSections: [] }),
    ).toContain(
      'may not be fully in sync (4 lines changed). Before finishing:',
    );
  });
});
