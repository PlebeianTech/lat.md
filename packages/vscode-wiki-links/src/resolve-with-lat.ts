/** The shape of Node's `child_process.execFile`, so tests can pass a fake. */
export type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string },
  callback: (
    error: { code?: string | number | null; message: string } | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

export type ResolveResult = { file: string; line: number } | { error: string };

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Runs `lat resolve -- TARGET` in `cwd` and returns where the target lives. */
export function resolveWithLat(
  execFile: ExecFile,
  latPath: string,
  target: string,
  cwd: string,
): Promise<ResolveResult> {
  return new Promise((resolve) => {
    execFile(
      latPath,
      ['resolve', '--', target],
      { cwd },
      (error, stdout, stderr) => {
        const processDidNotRun = error && typeof error.code !== 'number';
        if (processDidNotRun) {
          resolve({ error: `Could not run ${latPath}: ${error.message}` });
          return;
        }
        const output = parseJson(stdout);
        if (typeof output?.error === 'string') {
          resolve({ error: output.error });
        } else if (!error && typeof output?.file === 'string') {
          resolve({ file: output.file, line: Number(output.line) });
        } else {
          resolve({
            error: stderr.trim() || `lat resolve failed for [[${target}]]`,
          });
        }
      },
    );
  });
}
