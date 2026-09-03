import { describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInitMeta } from '../src/init-version.js';
import {
  extractForkBlock,
  readForkConventions,
  spliceForkBlock,
  writeForkInstructions,
} from '../src/cli/fork-instructions.js';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-fork-instructions-'));
  mkdirSync(join(root, 'lat.md'), { recursive: true });
  return root;
}

const alwaysYes = async () => true;
const alwaysNo = async () => false;

/** Silence the module's progress lines; they are not what these assert. */
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return fn().finally(() => spy.mockRestore());
}

describe('fork instruction block', () => {
  // @lat: [[fork-instructions#Fork Instructions#The block is appended, not merged into upstream's]]
  it("appends its own block and leaves upstream's alone", async () => {
    const root = makeRoot();
    try {
      const upstream =
        '# My App\n\nUser prose.\n\n%% lat:begin %%\nupstream template\n%% lat:end %%\n';
      writeFileSync(join(root, 'CLAUDE.md'), upstream);

      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), {}, alwaysYes),
      );

      const after = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
      expect(after.startsWith(upstream)).toBe(true);
      expect(after).toContain('%% lat-fork:begin %%');
      expect(extractForkBlock(after)).toBe(readForkConventions());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends its block to GEMINI.md when present', async () => {
    const root = makeRoot();
    try {
      const gemini = '# Gemini Instructions\n\n%% lat:begin %%\nupstream template\n%% lat:end %%\n';
      writeFileSync(join(root, 'GEMINI.md'), gemini);

      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), {}, alwaysYes),
      );

      const after = readFileSync(join(root, 'GEMINI.md'), 'utf-8');
      expect(after.startsWith(gemini)).toBe(true);
      expect(after).toContain('%% lat-fork:begin %%');
      expect(extractForkBlock(after)).toBe(readForkConventions());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[fork-instructions#Fork Instructions#Re-running writes nothing]]
  it('is idempotent across runs', async () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# My App\n');
      const hashes: Record<string, string> = {};

      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), hashes, alwaysYes),
      );
      const first = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
      writeInitMeta(join(root, 'lat.md'), hashes);

      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), hashes, alwaysNo),
      );
      expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[fork-instructions#Fork Instructions#Upstream can still rewrite its own block]]
  it("survives a rewrite of upstream's marker section", async () => {
    const root = makeRoot();
    try {
      writeFileSync(
        join(root, 'CLAUDE.md'),
        '%% lat:begin %%\nold upstream\n%% lat:end %%\n',
      );
      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), {}, alwaysYes),
      );

      // Simulate upstream's appendTemplateSection replacing only its own span.
      const content = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
      const begin = content.indexOf('%% lat:begin %%');
      const end = content.indexOf('%% lat:end %%') + '%% lat:end %%'.length + 1;
      const rewritten =
        content.slice(0, begin) +
        '%% lat:begin %%\nnew upstream\n%% lat:end %%\n' +
        content.slice(end);
      writeFileSync(join(root, 'CLAUDE.md'), rewritten);

      const after = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
      expect(after).toContain('new upstream');
      expect(extractForkBlock(after)).toBe(readForkConventions());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[fork-instructions#Fork Instructions#A skill is written only where the agent left a directory]]
  it('writes a conventions skill only into existing skill roots', async () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), {}, alwaysYes),
      );

      const written = join(
        root,
        '.claude',
        'skills',
        'lat-md-conventions',
        'SKILL.md',
      );
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, 'utf-8')).toContain(
        'name: lat-md-conventions',
      );
      expect(existsSync(join(root, '.pi'))).toBe(false);
      expect(existsSync(join(root, '.agents'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[fork-instructions#Fork Instructions#An edited block is not overwritten silently]]
  it('asks before replacing a block the user edited, and honours a refusal', async () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# My App\n');
      const hashes: Record<string, string> = {};
      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), hashes, alwaysYes),
      );
      writeInitMeta(join(root, 'lat.md'), hashes);

      const edited = readFileSync(join(root, 'CLAUDE.md'), 'utf-8').replace(
        'Every project has at least one',
        'MY EDIT — Every project has at least one',
      );
      writeFileSync(join(root, 'CLAUDE.md'), edited);

      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), hashes, alwaysNo),
      );
      expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe(edited);

      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), hashes, alwaysYes),
      );
      expect(extractForkBlock(readFileSync(join(root, 'CLAUDE.md'), 'utf-8'))).toBe(
        readForkConventions(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[fork-instructions#Fork Instructions#Nothing is created for an agent that was not set up]]
  it('creates no instruction file that setup did not already write', async () => {
    const root = makeRoot();
    try {
      await quiet(() =>
        writeForkInstructions(root, join(root, 'lat.md'), {}, alwaysYes),
      );
      expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(root, '.github'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[fork-instructions#Fork Instructions#The block carries the rules the check enforces]]
  it('states the Diátaxis, code-ref and comment-override rules', () => {
    const body = readForkConventions();
    expect(body).toContain('lat.md/explanation/');
    expect(body).toContain('require-mode: true');
    expect(body).toContain('exempt from this project');
    expect(body).toContain('not a language allowlist');
    expect(spliceForkBlock('', body)).toContain('%% lat-fork:begin %%');
  });

  // @lat: [[fork-instructions#Fork Instructions#The block gives both routes to a declared mode]]
  it('offers frontmatter declaration as well as a mode directory', () => {
    const body = readForkConventions();
    expect(body).toContain('mode: explanation');
    expect(body).toContain('whether or not the root index carries');
    expect(body).toContain('Prefer the declaration when');
    // The claim this replaced was false and cost a consumer a restructure.
    expect(body).not.toContain('where no check can see it');
  });

  // @lat: [[fork-instructions#Fork Instructions#The block demands one specialty per document]]
  it('demands one specialty per document, discrete and non-conflicting', () => {
    const body = readForkConventions();
    expect(body).toContain('One specialty per document');
    expect(body).toContain('Small');
    expect(body).toContain('Discrete');
    expect(body).toContain('Does not conflict');
    expect(body).toContain('Link to it');
  });

  // @lat: [[fork-instructions#Fork Instructions#The block tells the agent to read sections rather than files]]
  it('tells the agent to reach a section without opening its file', () => {
    const body = readForkConventions();
    expect(body).toContain('Read sections, not files');
    expect(body).toContain('lat section');
    expect(body).toContain('lat expand');
  });
});
