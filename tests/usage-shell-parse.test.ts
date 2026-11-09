import { describe, expect, it } from 'vitest';

import {
  bdCommands,
  bypassReadArguments,
  isInside,
  parseShell,
  shellWritePaths,
} from '../src/fork/usage/sources/shell-parse.js';

describe('shell parsing', () => {
  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('splits a command on separators and finds redirect writes', () => {
    const segments = parseShell('pnpm test > log.txt 2>&1 && cat a | tee b');
    expect(segments.map((s) => s.words)).toEqual([
      ['pnpm', 'test'],
      ['cat', 'a'],
      ['tee', 'b'],
    ]);
    expect(shellWritePaths(segments)).toEqual(['log.txt', 'b']);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('skips heredoc bodies and finds bd ids and bypass targets', () => {
    const segments = parseShell(
      'cat lat.md/x.md <<-EOF\n\tbd close lat-1 > no\n\tEOF\nbd close lat-2 --reason done',
    );
    expect(bdCommands(segments)).toEqual([
      { verb: 'close', issue_id: 'lat-2' },
    ]);
    expect(bypassReadArguments(segments)).toContain('lat.md/x.md');
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('finds bd ids whose prefix contains a hyphen', () => {
    const segments = parseShell(
      'bd update my-app-3x9 --claim && bd close claude-code-a1b.2',
    );
    expect(bdCommands(segments)).toEqual([
      { verb: 'claim', issue_id: 'my-app-3x9' },
      { verb: 'close', issue_id: 'claude-code-a1b.2' },
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('tests directory containment by whole path segments', () => {
    expect(isInside('/a/lat.md', '/a/lat.md/x')).toBe(true);
    expect(isInside('/a/lat.md', '/a/lat.md-other')).toBe(false);
  });
});
