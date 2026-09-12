import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { RemoteSurfaceDevTools } from './remoteSurfaceDevTools';
import { RemoteSurfaceDevToolsChunks } from './remoteSurfaceDevToolsChunks';
import {
  DEVTOOLS_CHUNK_BYTES, DEVTOOLS_TIMEOUT_MS, type DevToolsCommand, type DevToolsErrorCode,
} from './remoteSurfaceDevToolsProtocol';

const cleanups = new Set<() => void>();
afterEach(() => { for (const cleanup of cleanups) cleanup(); cleanups.clear(); });
const frontendPath = `/api/browser-devtools/${'a'.repeat(32)}/inspector.html`;
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const createClient = () => {
  const sent: DevToolsCommand[] = [];
  const client = new RemoteSurfaceDevTools((command) => { sent.push(command); return true; });
  cleanups.add(() => client.dispose());
  const lastStart = () => {
    for (let index = sent.length - 1; index >= 0; index--) {
      const command = sent[index];
      if (command.type === 'devtoolsStart') return command;
    }
    throw new Error('Expected a DevTools start command');
  };
  const attach = (tabId = 'sc:one', attachmentRequestId = 'attachment-one') => {
    client.setAttachment({ tabId, attachmentRequestId });
    client.setOpen(true);
    return lastStart();
  };
  const ready = (devtoolsId = 'devtools-one') => {
    client.receive(JSON.stringify({ ...lastStart(), type: 'devtoolsStarted', devtoolsId, frontendPath }));
  };
  return { client, sent, lastStart, attach, ready };
};

const encodedChunks = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const count = Math.ceil(bytes.length / DEVTOOLS_CHUNK_BYTES);
  return Array.from({ length: count }, (_, index) => ({
    devtoolsId: 'devtools-one', messageId: 'backend-one', index, count, byteLength: bytes.length,
    data: btoa(String.fromCharCode(...bytes.subarray(index * DEVTOOLS_CHUNK_BYTES, (index + 1) * DEVTOOLS_CHUNK_BYTES))),
  }));
};

describe('remote DevTools lifecycle', () => {
  test('waits for an exact target attachment and ignores a superseded startup', () => {
    const { client, sent, attach, lastStart, ready } = createClient();
    client.setOpen(true);
    expect(sent).toHaveLength(0);
    const oldStart = attach();
    client.setAttachment(null);
    client.setAttachment({ tabId: 'sc:two', attachmentRequestId: 'attachment-two' });
    expect(lastStart().tabId).toBe('sc:two');
    client.receive(JSON.stringify({ ...oldStart, type: 'devtoolsStarted', devtoolsId: 'old', frontendPath }));
    expect(client.getState().phase).toBe('connecting');
    ready();
    expect(client.getState().phase).toBe('ready');
    expect(client.getState().attachment?.attachmentRequestId).toBe('attachment-two');
  });

  test('closing startup cancels it and a late ready cannot reopen inspection', () => {
    const { client, attach, ready, sent } = createClient();
    attach();
    client.setOpen(false);
    expect(sent.at(-1)?.type).toBe('devtoolsStop');
    ready();
    expect(client.getState().open).toBe(false);
    expect(client.getState().frontendPath).toBeNull();
  });

  test('early backend events wait for the frontend port and do not survive a target change', () => {
    const { client, attach, ready } = createClient();
    attach(); ready();
    const message = JSON.stringify({ method: 'Runtime.executionContextCreated', params: { id: 42 } });
    client.receive(JSON.stringify({ type: 'devtoolsMessageChunk', ...encodedChunks(message)[0] }));
    const received: string[] = [];
    client.setMessageHandler((value) => received.push(value));
    expect(received).toEqual([message]);
    client.setAttachment({ tabId: 'sc:two', attachmentRequestId: 'two' });
    client.receive(JSON.stringify({ type: 'devtoolsMessageChunk', ...encodedChunks(message)[0] }));
    expect(received).toHaveLength(1);
  });

  test('startup errors use their correlation and preserve a fixed error code only', () => {
    const { client, attach } = createClient();
    const start = attach();
    client.receive(JSON.stringify({ ...start, type: 'devtoolsError', requestId: 'stale',
      code: 'DEVTOOLS_START_FAILED', message: 'not displayed' }));
    expect(client.getState().phase).toBe('connecting');
    client.receive(JSON.stringify({ ...start, type: 'devtoolsError', code: 'DEVTOOLS_START_FAILED', message: 'not displayed' }));
    expect(client.getState().errorCode).toBe('DEVTOOLS_START_FAILED');
    expect(JSON.stringify(client.getState())).not.toContain('not displayed');
  });

  test('control loss does not automatically take control again', () => {
    const { client, attach, ready, sent } = createClient();
    attach(); ready();
    client.receive(JSON.stringify({ type: 'devtoolsClosed', devtoolsId: 'devtools-one',
      code: 'DEVTOOLS_CONTROL_LOST', message: 'DevTools lost control of this page' }));
    client.setAttachment({ tabId: 'sc:one', attachmentRequestId: 'attachment-one' });
    expect(client.getState().phase).toBe('error');
    expect(sent.filter((entry) => entry.type === 'devtoolsStart')).toHaveLength(1);
  });
});

describe('DevTools flow control', () => {
  const createTransport = () => {
    const sent: DevToolsCommand[] = [];
    const received: string[] = [];
    const errors: DevToolsErrorCode[] = [];
    const transport = new RemoteSurfaceDevToolsChunks('devtools-one',
      (command) => { sent.push(command); return true; }, (text) => received.push(text), (code) => errors.push(code));
    cleanups.add(() => transport.dispose());
    return { transport, sent, received, errors };
  };

  test('sends at most eight unacknowledged chunks and advances on a cumulative acknowledgement', async () => {
    const { transport, sent, errors } = createTransport();
    transport.sendMessage('x'.repeat(DEVTOOLS_CHUNK_BYTES * 12));
    await nextTurn();
    expect(sent).toHaveLength(8);
    const first = sent[0];
    if (first.type !== 'devtoolsCommandChunk') throw new Error('Expected command chunk');
    transport.acknowledge({ type: 'devtoolsChunkAck', devtoolsId: first.devtoolsId,
      messageId: first.messageId, direction: 'command', index: 3 });
    await nextTurn();
    expect(sent).toHaveLength(12);
    expect(errors).toHaveLength(0);
  });

  test('queues a normal startup burst while limiting active logical messages to two', async () => {
    const { transport, sent, errors } = createTransport();
    for (let id = 0; id < 20; id++) transport.sendMessage(JSON.stringify({ id, method: 'Runtime.enable' }));
    await nextTurn();
    expect(sent).toHaveLength(2);
    for (const command of sent.slice()) {
      if (command.type !== 'devtoolsCommandChunk') throw new Error('Expected command chunk');
      transport.acknowledge({ type: 'devtoolsChunkAck', devtoolsId: command.devtoolsId,
        messageId: command.messageId, direction: 'command', index: 0 });
    }
    await nextTurn();
    expect(sent).toHaveLength(4);
    expect(errors).toHaveLength(0);
  });

  test('drains a 630-command frontend startup burst through delayed acknowledgements', async () => {
    const { transport, sent, errors } = createTransport();
    for (let id = 0; id < 630; id++) transport.sendMessage(JSON.stringify({ id, method: 'Debugger.getScriptSource' }));
    let acknowledged = 0;
    for (let turn = 0; turn < 320 && sent.length < 630 && errors.length === 0; turn++) {
      await nextTurn();
      for (const command of sent.slice(acknowledged)) {
        if (command.type !== 'devtoolsCommandChunk') throw new Error('Expected command chunk');
        transport.acknowledge({ type: 'devtoolsChunkAck', devtoolsId: command.devtoolsId,
          messageId: command.messageId, direction: 'command', index: command.index });
        acknowledged++;
      }
    }
    expect(errors).toHaveLength(0);
    expect(sent).toHaveLength(630);
  });

  test('starts backpressure deadlines only for commands with chunks in flight', async () => {
    const { transport } = createTransport();
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      for (let id = 0; id < 100; id++) transport.sendMessage(JSON.stringify({ id, method: 'Runtime.enable' }));
      expect(timers.mock.calls.filter((call) => call[1] === DEVTOOLS_TIMEOUT_MS)).toHaveLength(0);
      await nextTurn();
      expect(timers.mock.calls.filter((call) => call[1] === DEVTOOLS_TIMEOUT_MS)).toHaveLength(2);
    } finally {
      timers.mockRestore();
    }
  });

  test('fails a command whose in-flight chunks stop making acknowledgement progress', async () => {
    const { transport, errors } = createTransport();
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      transport.sendMessage('stalled');
      await nextTurn();
      const deadline = timers.mock.calls.find((call) => call[1] === DEVTOOLS_TIMEOUT_MS);
      if (!deadline || !(deadline[0] instanceof Function)) throw new Error('Expected an in-flight deadline');
      deadline[0]();
      expect(errors).toEqual(['DEVTOOLS_BACKPRESSURE']);
    } finally {
      timers.mockRestore();
    }
  });

  test('keeps a flood of tiny queued commands bounded by metadata count', () => {
    const { transport, errors } = createTransport();
    for (let id = 0; id < 10_000 && errors.length === 0; id++) {
      transport.sendMessage(JSON.stringify({ id, method: 'Runtime.enable' }));
    }
    expect(errors).toEqual(['DEVTOOLS_BACKPRESSURE']);
  });

  test('keeps queued command payload bytes bounded independently of message count', () => {
    const { transport, errors } = createTransport();
    transport.sendMessage('x'.repeat(12 * 1024 * 1024));
    transport.sendMessage('x'.repeat(13 * 1024 * 1024));
    expect(errors).toEqual(['DEVTOOLS_BACKPRESSURE']);
  });

  test('disposal drops queued commands before a later pump can send them', async () => {
    const { transport, sent, errors } = createTransport();
    for (let id = 0; id < 100; id++) transport.sendMessage(JSON.stringify({ id, method: 'Runtime.enable' }));
    transport.dispose();
    await nextTurn();
    expect(sent).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test('reassembles split UTF-8 without truncation and acknowledges only accepted chunks', () => {
    const { transport, sent, received, errors } = createTransport();
    const text = JSON.stringify({ result: { source: 'á😀'.repeat(20_000) } });
    const chunks = encodedChunks(text);
    for (const chunk of chunks) transport.receive(chunk);
    expect(received).toEqual([text]);
    expect(sent.at(-1)).toEqual({ type: 'devtoolsChunkAck', devtoolsId: 'devtools-one',
      messageId: 'backend-one', direction: 'message', index: chunks.length - 1 });
    expect(errors).toHaveLength(0);
  });

  test('duplicate chunks fail the channel rather than changing an assembled message', () => {
    const { transport, received, errors } = createTransport();
    const first = encodedChunks('x'.repeat(DEVTOOLS_CHUNK_BYTES + 1))[0];
    transport.receive(first);
    transport.receive(first);
    expect(errors).toEqual(['DEVTOOLS_INVALID_REQUEST']);
    expect(received).toHaveLength(0);
  });

  test('rejects noncanonical base64 and acknowledgements for unsent chunks', async () => {
    const { transport, sent, errors } = createTransport();
    transport.sendMessage('test');
    await nextTurn();
    const first = sent[0];
    if (first.type !== 'devtoolsCommandChunk') throw new Error('Expected command chunk');
    transport.acknowledge({ type: 'devtoolsChunkAck', devtoolsId: first.devtoolsId,
      messageId: first.messageId, direction: 'command', index: 5 });
    expect(errors).toEqual(['DEVTOOLS_INVALID_REQUEST']);
    const next = createTransport();
    next.transport.receive({ ...encodedChunks('test')[0], data: 'dGVzdA' });
    expect(next.errors).toEqual(['DEVTOOLS_INVALID_REQUEST']);
  });
});
