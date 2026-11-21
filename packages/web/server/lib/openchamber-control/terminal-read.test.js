import { describe, expect, it, vi } from 'vitest';

import { createTerminalReadAction } from './terminal-read.js';

const terminal = {
  sessionId: 'term-1',
  cwd: '/repo',
  status: 'running',
  exitCode: null,
  signal: null,
  createdAt: 1,
  mode: 'interactive',
  purpose: 'shell',
  text: 'hello\n',
  truncated: false,
  retainedBytes: 6,
};

const setup = ({
  settings = { agentTerminalToolEnabled: true },
  runtime = {
    listTerminals: vi.fn(() => [terminal]),
    readTerminal: vi.fn(() => terminal),
  },
  getTerminalRuntime,
} = {}) => {
  const action = createTerminalReadAction({
    readSettings: async () => settings,
    getTerminalRuntime: getTerminalRuntime ?? (() => runtime),
  });
  return { action, runtime };
};

describe('terminal.list', () => {
  it('refuses while the tool is off, before reading any terminal', async () => {
    for (const settings of [{}, { agentTerminalToolEnabled: false }, null]) {
      const { action, runtime } = setup({ settings });
      await expect(action('terminal.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 403 });
      expect(runtime.listTerminals).not.toHaveBeenCalled();
      expect(runtime.readTerminal).not.toHaveBeenCalled();
    }
  });

  it('lists the session folder by default and an explicit directory instead', async () => {
    const { action, runtime } = setup();

    await expect(action('terminal.list', {}, '/repo')).resolves.toEqual({ terminals: [terminal] });
    expect(runtime.listTerminals).toHaveBeenCalledWith({ directory: '/repo' });

    await action('terminal.list', { directory: '  /elsewhere  ' }, '/repo');
    expect(runtime.listTerminals).toHaveBeenLastCalledWith({ directory: '/elsewhere' });
  });

  it('answers 400 instead of listing every terminal when no folder resolves', async () => {
    const { action, runtime } = setup();
    await expect(action('terminal.list', {}, null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(action('terminal.list', {}, '  ')).rejects.toMatchObject({ statusCode: 400 });
    expect(runtime.listTerminals).not.toHaveBeenCalled();
  });

  it('answers 503 when this server has no terminal runtime', async () => {
    const { action } = setup({ getTerminalRuntime: () => null });
    await expect(action('terminal.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('terminal.read', () => {
  it('requires a terminal id', async () => {
    const { action, runtime } = setup();
    await expect(action('terminal.read', {}, '/repo')).rejects.toMatchObject({ statusCode: 400 });
    expect(runtime.readTerminal).not.toHaveBeenCalled();
  });

  it('reads one terminal, passing a numeric byte cap through', async () => {
    const { action, runtime } = setup();

    await expect(action('terminal.read', { sessionId: 'term-1', maxBytes: 1024 }, '/repo'))
      .resolves.toEqual(terminal);
    expect(runtime.readTerminal).toHaveBeenCalledWith('term-1', { maxBytes: 1024 });

    await action('terminal.read', { sessionId: 'term-1' }, '/repo');
    expect(runtime.readTerminal).toHaveBeenLastCalledWith('term-1', {});
  });

  it('names terminal.list in the error for an unknown terminal', async () => {
    const { action } = setup({
      runtime: { listTerminals: vi.fn(), readTerminal: vi.fn(() => null) },
    });
    await expect(action('terminal.read', { sessionId: 'gone' }, '/repo'))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('terminal.list') });
  });
});
