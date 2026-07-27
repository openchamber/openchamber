import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClaudeQuery } from './query.js';

describe('startClaudeQuery effort option', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('forwards effort to the Claude Agent SDK query options', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-effort-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });

    expect(seenOptions).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      cwd: tempDir,
      skills: 'all',
      forwardSubagentText: true,
      agentProgressSummaries: true,
      settingSources: ['user', 'project', 'local'],
    });
    await handle.close?.();
  });

  it('forwards mcpServers and allowedTools', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-mcp-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      includePartialMessages: false,
      mcpServers: {
        fs: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      allowedTools: ['Agent', 'mcp__fs__*'],
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });
    expect(seenOptions).toMatchObject({
      mcpServers: {
        fs: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      allowedTools: ['Agent', 'mcp__fs__*'],
    });
    await handle.close?.();
  });
  it('forwards Claude Code preset systemPrompt with OpenCode agent append', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-sysprompt-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Use OpenChamber build agent conventions.',
      },
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });

    expect(seenOptions).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Use OpenChamber build agent conventions.',
      },
    });
    await handle.close?.();
  });
});

describe('startClaudeQuery permissionMode allowlist', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  const runWith = async (permissionMode) => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-perm-'));
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      permissionMode,
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {} };
      },
    });
    await handle.close?.();
    return seenOptions;
  };

  for (const mode of ['default', 'acceptEdits', 'plan']) {
    it(`forwards the inherited mode "${mode}"`, async () => {
      expect((await runWith(mode)).permissionMode).toBe(mode);
    });
  }

  it('drops bypassPermissions so canUseTool cannot be defeated', async () => {
    expect(await runWith('bypassPermissions')).not.toHaveProperty('permissionMode');
  });

  it('drops unknown modes', async () => {
    expect(await runWith('totallyMadeUp')).not.toHaveProperty('permissionMode');
  });
});
