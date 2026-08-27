import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMode } from '../src/cli/check-mode.js';
import { INIT_VERSION, readInitVersion } from '../src/init-version.js';

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
  // The fixture directory holds two documents. `topic.md` keeps its
  // imperatives inside frontmatter and code blocks, where they are exempt;
  // `prose-run.md` repeats the very same sentences as ordinary prose, where
  // they must be flagged. Assertions are therefore scoped by target, and the
  // pair is what proves an exemption is positional rather than an accident
  // of which verbs `IMPERATIVE_VERBS` happens to list.
  async function topicErrors() {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    return errors.filter((e) => e.target.endsWith('topic'));
  }

  async function proseErrors() {
    const errors = await checkMode(
      latDir('mode-explanation-imperative'),
      caseDir('mode-explanation-imperative'),
    );
    return errors.filter((e) => e.target.endsWith('prose-run'));
  }

  it('flags a line starting with an imperative verb, naming the verb', async () => {
    const errors = await topicErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(11);
    expect(errors[0].message).toContain('"Set"');
  });

  it('does not flag an imperative inside a fenced code block', async () => {
    const errors = await topicErrors();
    expect(errors.some((e) => e.line === 14)).toBe(false);
  });

  // @lat: [[mode#Does not flag an imperative inside a frontmatter block scalar]]
  it('does not flag an imperative inside a frontmatter block scalar', async () => {
    const errors = await topicErrors();
    expect(errors.some((e) => e.line === 5)).toBe(false);
  });

  it('does not flag a heading line', async () => {
    const errors = await topicErrors();
    expect(errors.some((e) => e.line === 7)).toBe(false);
  });

  // @lat: [[mode#Does not flag an imperative inside a nested fence with a longer marker]]
  it('does not flag an imperative inside a nested fence using a longer marker', async () => {
    const errors = await topicErrors();
    expect(errors.some((e) => e.line === 19)).toBe(false);
  });

  // @lat: [[mode#Does not flag an imperative inside a four-space-indented code block]]
  it('does not flag an imperative inside a four-space-indented code block', async () => {
    const errors = await topicErrors();
    expect(errors.some((e) => e.line === 23)).toBe(false);
  });

  // @lat: [[mode#Still flags only the single ordinary-prose imperative]]
  it('still flags only the single ordinary-prose imperative', async () => {
    const errors = await topicErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(11);
  });

  // @lat: [[mode#Flags the exempted sentences when they appear as prose]]
  it('flags the same two sentences when they appear as ordinary prose', async () => {
    const errors = await proseErrors();
    expect(errors.map((e) => e.line)).toEqual([10, 12]);
    expect(errors[0].message).toContain('"Run"');
    expect(errors[1].message).toContain('"Run"');
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

describe('mode-proto-dir', () => {
  // @lat: [[mode#Does not treat an Object.prototype key as a mode directory]]
  it('does not treat a directory named after an Object.prototype key as a mode directory', async () => {
    const errors = await checkMode(
      latDir('mode-proto-dir'),
      caseDir('mode-proto-dir'),
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

    const targeted = runCli('headless-check', ['check', 'mode', '--', 'links']);
    expect(targeted.exitCode).toBe(0);
    expect(targeted.stderr).toBe('');
    expect(targeted.stdout).toContain(
      'mode: All documents match their Diátaxis mode',
    );
  });
});

describe('checkAllCommand includes mode errors', () => {
  it('includes the mode error in full check output with a non-zero exit', () => {
    const { stderr, exitCode } = runCli('mode-all-fail', ['check']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('a how-to must give ordered steps');
  });
});

describe('init-version', () => {
  let treeDir: string;

  beforeEach(() => {
    treeDir = join(tmpdir(), `lat-mode-init-${Date.now()}-${Math.random()}`);
    mkdirSync(treeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(treeDir, { recursive: true, force: true });
  });

  it('treats a tree recorded before the Diátaxis templates as outdated', () => {
    const cacheDir = join(treeDir, '.cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'lat_init.json'),
      JSON.stringify({ init_version: 3 }),
    );

    // 3 is the version that shipped before the Diátaxis mode work changed
    // templates/AGENTS.md and templates/skill/SKILL.md, both generated by
    // `lat init`. `lat check` warns only while the recorded version is below
    // INIT_VERSION, so 3 must stay below it or no existing tree is ever told
    // to re-run init and pick up the new documentation.
    expect(readInitVersion(treeDir)).toBe(3);
    expect(readInitVersion(treeDir)!).toBeLessThan(INIT_VERSION);
  });
});
