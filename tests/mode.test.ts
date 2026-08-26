import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { checkMode } from '../src/cli/check-mode.js';

const casesDir = join(import.meta.dirname, 'cases');
const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

function caseDir(name: string): string {
  return join(casesDir, name);
}

function latDir(name: string): string {
  return join(casesDir, name, 'lat.md');
}

function runCli(
  caseName: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: caseDir(caseName),
    encoding: 'utf-8',
    env: process.env,
  });

  return {
    stdout: (result.stdout ?? '').replaceAll('\\', '/'),
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('mode-none', () => {
  it('returns zero errors when no document declares a mode', async () => {
    const errors = await checkMode(latDir('mode-none'), caseDir('mode-none'));
    expect(errors).toEqual([]);
  });
});

describe('mode-mismatch', () => {
  it('flags a declared mode that does not match its directory', async () => {
    const errors = await checkMode(
      latDir('mode-mismatch'),
      caseDir('mode-mismatch'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
    expect(errors[0].message).toContain('explanation');
    expect(errors[0].message).toContain('how-to');
  });
});

describe('mode-unknown', () => {
  it('flags an unrecognized mode value and lists the valid modes', async () => {
    const errors = await checkMode(
      latDir('mode-unknown'),
      caseDir('mode-unknown'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('tutorial');
    expect(errors[0].message).toContain('how-to');
    expect(errors[0].message).toContain('reference');
    expect(errors[0].message).toContain('explanation');
  });
});

describe('mode-non-string-list', () => {
  it('flags a non-string (list) mode value instead of silently skipping validation', async () => {
    const errors = await checkMode(
      latDir('mode-non-string-list'),
      caseDir('mode-non-string-list'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('unknown mode');
    expect(errors[0].message).toContain('tutorial');
  });
});

describe('mode-null', () => {
  it('treats a bare `mode:` key with no value as absent, not an error', async () => {
    const errors = await checkMode(latDir('mode-null'), caseDir('mode-null'));
    expect(errors).toEqual([]);
  });
});

describe('mode-reference-prose', () => {
  it('flags a second paragraph under a heading at its line', async () => {
    const errors = await checkMode(
      latDir('mode-reference-prose'),
      caseDir('mode-reference-prose'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(13);
    expect(errors[0].message).toContain('Double');
  });

  it('does not flag a heading with exactly one paragraph', async () => {
    const errors = await checkMode(
      latDir('mode-reference-prose'),
      caseDir('mode-reference-prose'),
    );
    expect(errors.some((e) => e.message.includes('Single'))).toBe(false);
  });

  it('does not flag the lead paragraph before the first heading', async () => {
    const errors = await checkMode(
      latDir('mode-reference-prose'),
      caseDir('mode-reference-prose'),
    );
    expect(errors.some((e) => e.line === 1)).toBe(false);
  });
});

describe('mode-howto-steps', () => {
  it('flags a how-to with no numbered list', async () => {
    const errors = await checkMode(
      latDir('mode-howto-steps'),
      caseDir('mode-howto-steps'),
    );
    const noList = errors.filter((e) => e.target.includes('no-list'));
    expect(noList).toHaveLength(1);
    expect(noList[0].message).toContain('numbered list');
  });

  it('does not flag a how-to with a numbered list', async () => {
    const errors = await checkMode(
      latDir('mode-howto-steps'),
      caseDir('mode-howto-steps'),
    );
    expect(errors.some((e) => e.target.includes('with-list'))).toBe(false);
  });
});

describe('mode-tutorial', () => {
  it('flags a tutorial with no numbered list', async () => {
    const errors = await checkMode(
      latDir('mode-tutorial'),
      caseDir('mode-tutorial'),
    );
    const missingList = errors.filter((e) => e.target.includes('missing-list'));
    expect(missingList).toHaveLength(1);
    expect(missingList[0].message).toContain('ordered steps');
  });

  it('flags a tutorial with no stated outcome', async () => {
    const errors = await checkMode(
      latDir('mode-tutorial'),
      caseDir('mode-tutorial'),
    );
    const missingOutcome = errors.filter((e) =>
      e.target.includes('missing-outcome'),
    );
    expect(missingOutcome).toHaveLength(1);
    expect(missingOutcome[0].message).toContain('outcome');
  });

  it('passes a tutorial with both an ordered list and a stated outcome', async () => {
    const errors = await checkMode(
      latDir('mode-tutorial'),
      caseDir('mode-tutorial'),
    );
    expect(errors.some((e) => e.target.endsWith('both'))).toBe(false);
  });
});

describe('mode-explanation-imperative', () => {
  it('flags a line starting with an imperative verb, naming the verb', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(10);
    expect(errors[0].message).toContain('"Set"');
  });

  it('does not flag an imperative inside a fenced code block', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors.some((e) => e.line === 13)).toBe(false);
  });

  it('does not flag an imperative inside a frontmatter value', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors.some((e) => e.line === 4)).toBe(false);
  });

  it('does not flag a heading line', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors.some((e) => e.line === 6)).toBe(false);
  });

  // @lat: [[mode#Does not flag an imperative inside a nested fence with a longer marker]]
  it('does not flag an imperative inside a nested fence using a longer marker', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors.some((e) => e.line === 18)).toBe(false);
  });

  // @lat: [[mode#Does not flag an imperative inside a four-space-indented code block]]
  it('does not flag an imperative inside a four-space-indented code block', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors.some((e) => e.line === 22)).toBe(false);
  });

  // @lat: [[mode#Still flags only the single ordinary-prose imperative]]
  it('still flags only the single ordinary-prose imperative', async () => {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(10);
  });
});

describe('mode-dir-implied', () => {
  it('applies the reference shape rule from the directory when no mode is declared', async () => {
    const errors = await checkMode(
      latDir('mode-dir-implied'),
      caseDir('mode-dir-implied'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('narrative prose');
  });
});

describe('mode-flat-declared', () => {
  it('allows a declared mode outside any mode directory and still applies its shape rule', async () => {
    const errors = await checkMode(
      latDir('mode-flat-declared'),
      caseDir('mode-flat-declared'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('narrative prose');
  });
});

describe('check mode subcommand', () => {
  it('exits non-zero and prints the error on a failing fixture', () => {
    const { stderr, exitCode } = runCli('mode-subcommand-fail', [
      'check',
      'mode',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('imperative "Set"');
    expect(stderr).toContain('1 error found');
  });

  it('exits zero and prints the success line on a passing fixture', () => {
    const { stdout, stderr, exitCode } = runCli('mode-subcommand-pass', [
      'check',
      'mode',
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('mode: All documents match their Diátaxis mode\n');
  });
});

describe('checkAllCommand includes mode errors', () => {
  it('includes the mode error in full check output with a non-zero exit', () => {
    const { stderr, exitCode } = runCli('mode-all-fail', ['check']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('a how-to must give ordered steps');
  });
});
