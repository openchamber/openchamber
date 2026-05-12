import { beforeEach, describe, expect, it, vi } from 'vitest';

const subprocesses = [];

vi.mock('./jsonrpc-subprocess.js', () => ({
  createJsonRpcSubprocess: (options) => {
    const rpc = {
      options,
      isAlive: vi.fn(() => true),
      kill: vi.fn(),
      shutdown: vi.fn(async () => {}),
      sendNotification: vi.fn(),
      sendResponse: vi.fn(),
      sendRequest: vi.fn(async (method) => {
        if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        if (method === 'model/list') return { data: [] };
        return {};
      }),
    };
    subprocesses.push(rpc);
    return rpc;
  },
}));

const { createCodexAppServerAdapter } = await import('./codex-appserver.js');

const crypto = {
  randomBytes(size) {
    return Buffer.alloc(size, 1);
  },
};

describe('Codex app-server adapter event mapping', () => {
  beforeEach(() => {
    subprocesses.length = 0;
    process.env.CODEX_PATH = '/bin/sh';
  });

  it('maps official content notifications to stable part lifecycle and delta events', async () => {
    const events = [];
    const adapter = createCodexAppServerAdapter({
      crypto,
      emitEvent: (directory, payload) => events.push({ directory, payload }),
    });

    await adapter.getOrCreateProcess('session-1', '/repo', {});
    await adapter.startTurn('session-1', [{ type: 'text', text: 'hello' }], {
      info: { id: 'msg-assistant-1', sessionID: 'session-1', role: 'assistant', time: { created: 1 } },
      parts: [],
    });

    subprocesses[0].options.onNotification('item/started', {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'bun test',
        cwd: '/repo',
        status: 'running',
        commandActions: [],
      },
    });
    subprocesses[0].options.onNotification('item/commandExecution/outputDelta', {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      delta: 'ok',
    });
    subprocesses[0].options.onNotification('item/completed', {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      completedAtMs: 10,
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'bun test',
        cwd: '/repo',
        status: 'completed',
        aggregatedOutput: 'ok',
        commandActions: [],
      },
    });

    expect(events.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'message.part.delta',
      'message.part.updated',
    ]);
    expect(events[1].payload.properties.part).toEqual(expect.objectContaining({
      id: 'msg-assistant-1_000001_tool-output_cmd-1',
      type: 'tool',
      tool: 'bash',
      state: expect.objectContaining({
        status: 'running',
        output: '',
        input: expect.objectContaining({ command: 'bun test', cwd: '/repo' }),
      }),
    }));
    expect(events[2].payload.properties).toEqual(expect.objectContaining({
      messageID: 'msg-assistant-1',
      partID: 'msg-assistant-1_000001_tool-output_cmd-1',
      field: 'output',
      delta: 'ok',
    }));
    expect(events[3].payload.properties.part.state).toEqual(expect.objectContaining({
      status: 'completed',
      output: 'ok',
    }));
  });

  it('orders Codex parts by first-seen item sequence instead of part type', async () => {
    const events = [];
    const adapter = createCodexAppServerAdapter({
      crypto,
      emitEvent: (directory, payload) => events.push({ directory, payload }),
    });

    await adapter.getOrCreateProcess('session-1', '/repo', {});
    await adapter.startTurn('session-1', [{ type: 'text', text: 'hello' }], {
      info: { id: 'msg-assistant-1', sessionID: 'session-1', role: 'assistant', time: { created: 1 } },
      parts: [],
    });

    subprocesses[0].options.onNotification('item/started', {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      item: { id: 'reason-1', type: 'reasoning' },
    });
    subprocesses[0].options.onNotification('item/started', {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'bun test',
        cwd: '/repo',
        status: 'running',
        commandActions: [],
      },
    });
    subprocesses[0].options.onNotification('item/agentMessage/delta', {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      delta: 'Done',
    });

    const partIds = events
      .filter((event) => event.payload.type === 'message.part.updated')
      .map((event) => event.payload.properties.part.id);

    expect(partIds).toEqual([
      'msg-assistant-1_000001_reasoning_reason-1',
      'msg-assistant-1_000002_tool-output_cmd-1',
      'msg-assistant-1_000003_text_text-1',
    ]);
    expect([...partIds].sort()).toEqual(partIds);
  });

  it('forwards Codex threadName updates to backend callback', async () => {
    const events = [];
    const onThreadNameUpdated = vi.fn();
    const adapter = createCodexAppServerAdapter({
      crypto,
      emitEvent: (directory, payload) => events.push({ directory, payload }),
      onThreadNameUpdated,
    });

    await adapter.getOrCreateProcess('session-1', '/repo', {});
    subprocesses[0].options.onNotification('thread/name/updated', {
      threadId: 'codex-thread-1',
      threadName: 'Generated title',
    });

    expect(events).toHaveLength(0);
    expect(onThreadNameUpdated).toHaveBeenCalledWith('session-1', 'Generated title');
  });
});
