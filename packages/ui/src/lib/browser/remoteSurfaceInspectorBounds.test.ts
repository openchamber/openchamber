import { describe, expect, test } from 'bun:test';
import { RemoteSurfaceInspector, RemoteSurfaceInspectorError } from './remoteSurfaceInspector';
import type { SurfaceInspectorCommand } from './remoteSurfaceInspectorProtocol';

const openInspector = () => {
  const commands: SurfaceInspectorCommand[] = [];
  const inspector = new RemoteSurfaceInspector((command) => { commands.push(command); return true; });
  inspector.setAttachment('sc:one');
  inspector.setOpen(true);
  inspector.receive(JSON.stringify({ type: 'inspectorStarted', tabId: 'sc:one',
    requestId: commands.at(-1)?.requestId, captureId: 'capture' }));
  return { inspector, commands };
};

const request = (id: string) => ({ id, timestamp: 1, method: 'GET', url: 'https://fixture.test/data',
  resourceType: 'Fetch', status: 200, statusText: 'OK', mimeType: 'application/json',
  durationMs: 10, encodedBytes: 50, state: 'complete', failureText: null, fromCache: false });

describe('remote inspector bounded state', () => {
  test('caps serialized console data when escaping makes rows larger than their character counts', () => {
    const { inspector } = openInspector();
    try {
      for (let offset = 0; offset < 300; offset += 2) inspector.receive(JSON.stringify({
        type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture', network: [],
        droppedConsole: 0, droppedNetwork: 0,
        console: Array.from({ length: 2 }, (_, index) => ({
          id: String(offset + index), timestamp: 1, level: 'log', text: '\u0000'.repeat(4000),
          source: '', line: null, truncated: false,
        })),
      }));

      const state = inspector.getState();
      expect(new TextEncoder().encode(JSON.stringify(state.console)).byteLength).toBeLessThanOrEqual(1024 * 1024);
      expect(state.console.length).toBeGreaterThan(0);
      expect(state.console.length).toBeLessThan(300);
      expect(state.droppedConsole).toBe(300 - state.console.length);
    } finally { inspector.setOpen(false); }
  });

  test('caps network rows during a three-hundred-request burst', () => {
    const { inspector } = openInspector();
    try {
      for (let offset = 0; offset < 300; offset += 25) inspector.receive(JSON.stringify({
        type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture', console: [],
        network: Array.from({ length: 25 }, (_, index) => request(String(offset + index))),
        droppedConsole: 0, droppedNetwork: 0,
      }));

      expect(inspector.getState().network).toHaveLength(200);
      expect(inspector.getState().network.at(-1)?.id).toBe('299');
      expect(inspector.getState().droppedNetwork).toBe(100);
    } finally { inspector.setOpen(false); }
  });

  test('requests bodies only when the caller explicitly includes them', async () => {
    const { inspector, commands } = openInspector();
    inspector.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture',
      console: [], network: [request('request')], droppedConsole: 0, droppedNetwork: 0 }));
    const response = inspector.requestDetails('request', false);
    try {
      const command = commands.at(-1);
      if (command?.type !== 'inspectorRequest') throw new Error('Expected request details command');
      expect(command.includeBody).toBe(false);
      inspector.receive(JSON.stringify({ type: 'inspectorRequestResult', tabId: 'sc:one', captureId: 'capture',
        requestId: command.requestId, entryId: 'request', requestHeaders: [], responseHeaders: [],
        requestBody: null, responseBody: null, bodyState: 'not-requested', truncated: false }));

      expect((await response).bodyState).toBe('not-requested');
    } finally { inspector.setOpen(false); }
  });

  test('cancels pending request details when the network capture is cleared', async () => {
    const { inspector } = openInspector();
    inspector.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture',
      console: [], network: [request('request')], droppedConsole: 0, droppedNetwork: 0 }));
    const outcome = inspector.requestDetails('request', true).then(() => 'resolved',
      (error) => error instanceof RemoteSurfaceInspectorError ? error.code : 'other');
    try {
      inspector.clear('network');

      expect(await outcome).toBe('CANCELLED');
    } finally { inspector.setOpen(false); }
  });

  test('retains usable capture after the server rejects a clear operation', () => {
    const { inspector, commands } = openInspector();
    inspector.clear('network');
    try {
      inspector.receive(JSON.stringify({ type: 'inspectorError', tabId: 'sc:one', captureId: 'capture',
        requestId: commands.at(-1)?.requestId, code: 'INVALID_REQUEST', message: 'untrusted diagnostic' }));

      expect(inspector.getState().phase).toBe('capturing');
      expect(inspector.getState().errorCode).toBe('INVALID_REQUEST');
      expect(inspector.getState().errorMessage).not.toContain('untrusted diagnostic');
    } finally { inspector.setOpen(false); }
  });

  test('rejects an expression whose encoded command exceeds the socket limit', async () => {
    const { inspector, commands } = openInspector();
    const commandCount = commands.length;
    try {
      const outcome = inspector.evaluate('\u0000'.repeat(16_000)).then(() => 'resolved',
        (error) => error instanceof RemoteSurfaceInspectorError ? error.code : 'other');

      expect(await outcome).toBe('INVALID_REQUEST');
      expect(commands.length).toBe(commandCount);
    } finally { inspector.setOpen(false); }
  });

  test('rejects event timestamps that cannot be rendered as dates', () => {
    const { inspector } = openInspector();
    const before = inspector.getState();
    try {
      inspector.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture',
        console: [], network: [{ ...request('invalid-date'), timestamp: 9e15 }],
        droppedConsole: 0, droppedNetwork: 0 }));

      expect(inspector.getState()).toBe(before);
    } finally { inspector.setOpen(false); }
  });

  test('accepts request details only for the selected network entry', async () => {
    const { inspector, commands } = openInspector();
    inspector.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:one', captureId: 'capture',
      console: [], network: [request('selected')], droppedConsole: 0, droppedNetwork: 0 }));
    const response = inspector.requestDetails('selected', true);
    const requestId = commands.at(-1)?.requestId;
    try {
      for (const entryId of ['unrelated', 'selected']) inspector.receive(JSON.stringify({
        type: 'inspectorRequestResult', tabId: 'sc:one', captureId: 'capture', requestId,
        entryId, requestHeaders: [], responseHeaders: [], requestBody: null,
        responseBody: entryId, bodyState: 'available', truncated: false,
      }));

      expect((await response).responseBody).toBe('selected');
    } finally { inspector.setOpen(false); }
  });
});
