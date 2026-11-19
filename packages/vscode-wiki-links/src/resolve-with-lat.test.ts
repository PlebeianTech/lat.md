import { describe, it, expect } from 'vitest';
import { resolveWithLat, type ExecFile } from './resolve-with-lat.js';

function fakeExecFile(
  error: Parameters<Parameters<ExecFile>[3]>[0],
  stdout: string,
  stderr = '',
): ExecFile {
  return (_file, _args, _options, callback) => callback(error, stdout, stderr);
}

const exitCode1 = { code: 1, message: 'Command failed' };

describe('resolveWithLat', () => {
  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Resolved target gives file and line]]
  it('returns the file and line from success JSON', async () => {
    const execFile = fakeExecFile(
      null,
      '{"file":"/repo/lat.md/cli.md","line":9}\n',
    );
    expect(
      await resolveWithLat(execFile, 'lat', 'cli#locate', '/repo'),
    ).toEqual({
      file: '/repo/lat.md/cli.md',
      line: 9,
    });
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Error JSON gives its message]]
  it('returns the message from error JSON on exit code 1', async () => {
    const execFile = fakeExecFile(
      exitCode1,
      '{"error":"no section or file found for [[x]]"}\n',
    );
    expect(await resolveWithLat(execFile, 'lat', 'x', '/repo')).toEqual({
      error: 'no section or file found for [[x]]',
    });
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Output without JSON falls back to stderr]]
  it('uses stderr when stdout is empty or not JSON', async () => {
    const stderr = 'No lat.md directory found\nRun `lat init` to create one.\n';
    const expected = {
      error: 'No lat.md directory found\nRun `lat init` to create one.',
    };
    expect(
      await resolveWithLat(
        fakeExecFile(exitCode1, '', stderr),
        'lat',
        'x',
        '/repo',
      ),
    ).toEqual(expected);
    expect(
      await resolveWithLat(
        fakeExecFile(exitCode1, 'oops', stderr),
        'lat',
        'x',
        '/repo',
      ),
    ).toEqual(expected);
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#Spawn failure gives a readable error]]
  it('names the binary when it cannot be started', async () => {
    const spawnError = { code: 'ENOENT', message: 'spawn lat ENOENT' };
    expect(
      await resolveWithLat(fakeExecFile(spawnError, ''), 'lat', 'x', '/repo'),
    ).toEqual({ error: 'Could not run lat: spawn lat ENOENT' });
  });

  // @lat: [[fork-vscode-wiki-links#Fork VS Code Wiki Links#CLI is called with the target after a double dash]]
  it('passes resolve, --, the target and the cwd to exec', async () => {
    const calls: unknown[] = [];
    const execFile: ExecFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '{"file":"/a.md","line":1}', '');
    };
    await resolveWithLat(execFile, '/bin/lat', '-a#b', '/repo/src');
    expect(calls).toEqual([
      {
        file: '/bin/lat',
        args: ['resolve', '--', '-a#b'],
        options: { cwd: '/repo/src' },
      },
    ]);
  });
});
