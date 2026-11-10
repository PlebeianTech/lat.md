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
  it('finds the bd verb after global flags', () => {
    const bd = (command: string) => bdCommands(parseShell(command));
    expect(bd('bd --sandbox --actor x update a-1 --claim')).toEqual([
      { verb: 'claim', issue_id: 'a-1' },
    ]);
    expect(bd('bd --actor=x --db /tmp/b close lat-2')).toEqual([
      { verb: 'close', issue_id: 'lat-2' },
    ]);
    expect(bd('bd --sandbox close lat-1')).toEqual([
      { verb: 'close', issue_id: 'lat-1' },
    ]);
    expect(bd('bd close --no-daemon lat-1')).toEqual([
      { verb: 'close', issue_id: 'lat-1' },
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('takes only file arguments as bypass reads, never a pattern or script', () => {
    const targets = (command: string) =>
      bypassReadArguments(parseShell(command));
    expect(targets('grep -rn "lat.md" src')).toEqual(['src']);
    expect(targets('rg lat.md/ src/')).toEqual(['src/']);
    expect(targets('git grep -n lat.md -- src')).toEqual(['src']);
    expect(targets("sed -n '/lat.md/p' x")).toEqual(['x']);
    expect(targets("awk '/lat.md/' x")).toEqual(['x']);
    expect(targets('find src -name lat.md')).toEqual(['src']);
    expect(targets('grep -e foo lat.md/a.md')).toEqual(['lat.md/a.md']);
    expect(targets('rg --regexp=foo lat.md')).toEqual(['lat.md']);
    expect(targets("sed -e 's/a/b/' lat.md/a.md")).toEqual(['lat.md/a.md']);
    expect(targets('cat -- lat.md/a.md')).toEqual(['lat.md/a.md']);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('skips git global options before grep and joins targets onto -C', () => {
    const targets = (command: string) =>
      bypassReadArguments(parseShell(command));
    expect(targets('git -C /x grep foo lat.md')).toEqual(['/x/lat.md']);
    expect(targets('git -C /x grep foo /y/lat.md')).toEqual(['/y/lat.md']);
    expect(targets('git -C repo grep foo lat.md/')).toEqual(['repo/lat.md/']);
    expect(
      targets('git -c core.quotepath=off grep -n foo -- lat.md/a.md'),
    ).toEqual(['lat.md/a.md']);
    expect(
      targets('git --no-pager --git-dir=.git --work-tree w -P grep foo lat.md'),
    ).toEqual(['lat.md']);
    expect(targets('git -C /x log lat.md')).toEqual([]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('reads the -C directory for a git grep with no path', () => {
    const targets = (command: string) =>
      bypassReadArguments(parseShell(command));
    expect(targets('git -C lat.md grep -n foo')).toEqual(['lat.md']);
    expect(targets('git -C repo -C lat.md grep -e foo')).toEqual([
      'repo/lat.md',
    ]);
    expect(targets('git grep foo')).toEqual([]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('drops a comment to the end of its line', () => {
    expect(
      bdCommands(parseShell('bd update lat-5 --claim  # then lat-6')),
    ).toEqual([{ verb: 'claim', issue_id: 'lat-5' }]);
    expect(bdCommands(parseShell('bd close lat-1  # lat-2 is next'))).toEqual([
      { verb: 'close', issue_id: 'lat-1' },
    ]);
    expect(bypassReadArguments(parseShell('ls src  # not lat.md'))).toEqual([
      'src',
    ]);
    expect(
      parseShell("echo a#b '#c' # x\nbd close lat-3").map((s) => s.words),
    ).toEqual([
      ['echo', 'a#b', '#c'],
      ['bd', 'close', 'lat-3'],
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('takes only files as in-place sed edits, never the script', () => {
    const writes = (command: string) => shellWritePaths(parseShell(command));
    expect(writes("sed -i '' 's/old/new/' src/a.ts")).toEqual(['src/a.ts']);
    expect(writes("sed -i -e 's/a/b/' -e 's/c/d/' f")).toEqual(['f']);
    expect(writes("sed -i 's/a/b/' f g")).toEqual(['f', 'g']);
    expect(writes('sed -i.bak -f edit.sed f')).toEqual(['f']);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('removes a backslash-newline line continuation', () => {
    expect(bdCommands(parseShell('bd \\\n  close lat-1'))).toEqual([
      { verb: 'close', issue_id: 'lat-1' },
    ]);
    expect(bypassReadArguments(parseShell('cat \\\nlat.md/x.md'))).toEqual([
      'lat.md/x.md',
    ]);
    expect(parseShell('echo "a\\\nb" \'c\\\nd\'')[0].words).toEqual([
      'echo',
      'ab',
      'c\\\nd',
    ]);
  });

  // @lat: [[usage-source-claude#Usage Source Claude#Shell parsing is shared by the readers]]
  it('tests directory containment by whole path segments', () => {
    expect(isInside('/a/lat.md', '/a/lat.md/x')).toBe(true);
    expect(isInside('/a/lat.md', '/a/lat.md-other')).toBe(false);
  });
});
