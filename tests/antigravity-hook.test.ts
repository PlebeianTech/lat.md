import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractLastUserPrompt,
  handleAntigravityPreInvocation,
  handleAntigravityPreToolUse,
  handleAntigravityPostToolUse,
  handleAntigravityStop,
  handleAntigravityHook,
} from '../src/fork/antigravity-hook.js';

describe('antigravity hook handler', () => {
  describe('extractLastUserPrompt', () => {
    it('extracts the last USER_INPUT from a transcript file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lat-agy-transcript-'));
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        const lines = [
          JSON.stringify({ type: 'USER_INPUT', content: 'First message' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Replying...' }),
          JSON.stringify({ type: 'USER_INPUT', content: 'Target user prompt' }),
          JSON.stringify({ type: 'TOOL_CALL', name: 'run_command' }),
        ].join('\n');
        writeFileSync(transcriptPath, lines);

        const prompt = extractLastUserPrompt(transcriptPath);
        expect(prompt).toBe('Target user prompt');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('extracts user prompt from role: user and parts array', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lat-agy-transcript-'));
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        const lines = [
          JSON.stringify({ role: 'user', parts: [{ text: 'Structured prompt' }] }),
          JSON.stringify({ role: 'model', parts: [{ text: 'Answer' }] }),
        ].join('\n');
        writeFileSync(transcriptPath, lines);

        const prompt = extractLastUserPrompt(transcriptPath);
        expect(prompt).toBe('Structured prompt');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null if transcript file does not exist', () => {
      expect(extractLastUserPrompt('/nonexistent/path.jsonl')).toBeNull();
    });
  });

  describe('handleAntigravityPreInvocation', () => {
    it('returns ephemeralMessage with lat.md update reminder', async () => {
      const input = JSON.stringify({
        conversationId: 'test-conv-id',
        user_prompt: 'Hello lat',
      });
      const output = await handleAntigravityPreInvocation(input, false);
      expect(output.injectSteps).toHaveLength(1);
      expect(output.injectSteps[0].ephemeralMessage).toContain('lat.md/');
      expect(output.injectSteps[0].ephemeralMessage).toContain('lat search');
    });

    it('fails open on corrupted json input', async () => {
      const output = await handleAntigravityPreInvocation('not-json{', false);
      expect(output.injectSteps).toBeDefined();
    });
  });

  describe('handleAntigravityPreToolUse', () => {
    it('allows non-edit tools', async () => {
      const input = JSON.stringify({
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'ls' },
        },
      });
      const output = await handleAntigravityPreToolUse(input, false);
      expect(output.decision).toBe('allow');
    });

    it('allows clean code edits without rationale comments', async () => {
      const input = JSON.stringify({
        toolCall: {
          name: 'write_to_file',
          args: {
            TargetFile: '/path/to/file.ts',
            CodeContent: 'export const value = 42;\n',
          },
        },
      });
      const output = await handleAntigravityPreToolUse(input, false);
      expect(output.decision).toBe('allow');
    });

    it('denies edits containing multi-line rationale comments in replace_file_content', async () => {
      const commentProse =
        '// We decided to use 42 because\n' +
        '// the upstream service demands an integer\n' +
        '// and previous attempts failed with timeout.\n';
      const input = JSON.stringify({
        toolCall: {
          name: 'replace_file_content',
          args: {
            TargetFile: '/path/to/service.ts',
            TargetContent: 'const old = 1;\n',
            ReplacementContent: commentProse + 'export const val = 42;\n',
          },
        },
      });
      const output = await handleAntigravityPreToolUse(input, false);
      expect(output.decision).toBe('deny');
      expect(output.reason).toContain('Blocked by the lat.md comment convention');
      expect(output.reason).toContain('Put the reasoning in a lat.md/ section');
    });

    it('denies writes containing multi-line rationale comments in write_to_file', async () => {
      const commentProse =
        '// We decided to use 42 because\n' +
        '// the upstream service demands an integer\n' +
        '// and previous attempts failed with timeout.\n';
      const input = JSON.stringify({
        toolCall: {
          name: 'write_to_file',
          args: {
            TargetFile: '/path/to/service.ts',
            CodeContent: commentProse + 'export const val = 42;\n',
          },
        },
      });
      const output = await handleAntigravityPreToolUse(input, false);
      expect(output.decision).toBe('deny');
    });

    it('fails open on malformed json', async () => {
      const output = await handleAntigravityPreToolUse('invalid-json', false);
      expect(output.decision).toBe('allow');
    });

    it('handles namespaced tool name and relative file path', async () => {
      const commentProse =
        '// We decided to use 42 because\n' +
        '// the upstream service demands an integer\n' +
        '// and previous attempts failed with timeout.\n';
      const input = JSON.stringify({
        toolCall: {
          name: 'default_api:replace_file_content',
          args: {
            TargetFile: 'src/service.ts',
            TargetContent: 'const old = 1;\n',
            ReplacementContent: commentProse + 'export const val = 42;\n',
          },
        },
        workspacePaths: ['/fake/project'],
      });
      const output = await handleAntigravityPreToolUse(input, false);
      expect(output.decision).toBe('deny');
    });
  });

  describe('handleAntigravityPostToolUse', () => {
    it('returns empty object and fails open', async () => {
      const output = await handleAntigravityPostToolUse('{}', false);
      expect(output).toEqual({});
    });
  });

  describe('handleAntigravityStop', () => {
    it('does not continue if executionNum > 1 to avoid infinite loop', async () => {
      const input = JSON.stringify({ executionNum: 2 });
      const output = await handleAntigravityStop(input, false);
      expect(output.decision).toBeUndefined();
    });

    it('does not continue if execution_num > 1 (snake_case) to avoid loop', async () => {
      const input = JSON.stringify({ execution_num: 3 });
      const output = await handleAntigravityStop(input, false);
      expect(output.decision).toBeUndefined();
    });

    it('does not continue if stop_hook_active is true', async () => {
      const input = JSON.stringify({ stop_hook_active: true });
      const output = await handleAntigravityStop(input, false);
      expect(output.decision).toBeUndefined();
    });
  });

  describe('handleAntigravityHook', () => {
    it('dispatches case-insensitively', async () => {
      await expect(
        handleAntigravityHook('posttooluse', '{}'),
      ).resolves.toBeUndefined();
    });
  });

  describe('hookCmd dispatch', () => {
    it('dispatches antigravity and gemini events in hookCmd', async () => {
      const { hookCmd } = await import('../src/cli/hook.js');
      await expect(hookCmd('antigravity', 'PostToolUse')).resolves.toBeUndefined();
      await expect(hookCmd('gemini', 'PostToolUse')).resolves.toBeUndefined();
    });
  });
});
