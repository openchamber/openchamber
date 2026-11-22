import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HandoffProbeAbort,
  checkInheritedListenerAddress,
  checkStateVersions,
  createHandoffProbeGate,
} from './handoff-probe.js';
import {
  HANDOFF_ABORT_MESSAGE,
  HANDOFF_GO_MESSAGE,
  HANDOFF_HELLO_MESSAGE,
} from './self-handoff.js';
import { resolveManagedOpenCodePaths } from './managed-opencode-state.js';

// The successor's preflight and hello/go exchange, with the IPC channel and the
// launch preview faked. The oracle is the design's section 3: a failed check is a
// `preflight-failed` abort the predecessor can name, and nothing listens before `go`.

describe('checkInheritedListenerAddress', () => {
  const inspectOk = (address) => () => ({ ok: true, address });

  it('accepts a listening socket on the expected port and host', () => {
    const result = checkInheritedListenerAddress({ port: 3000, host: '127.0.0.1', inspect: inspectOk({ address: '127.0.0.1', port: 3000, family: 'IPv4' }) });
    expect(result.ok).toBe(true);
  });

  it('refuses a socket on another port', () => {
    const result = checkInheritedListenerAddress({ port: 3000, host: '127.0.0.1', inspect: inspectOk({ address: '127.0.0.1', port: 3001, family: 'IPv4' }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('3001');
  });

  it('refuses a socket bound to another host', () => {
    const result = checkInheritedListenerAddress({ port: 3000, host: '127.0.0.1', inspect: inspectOk({ address: '0.0.0.0', port: 3000, family: 'IPv4' }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('0.0.0.0');
  });

  it('passes an inspection failure through', () => {
    const result = checkInheritedListenerAddress({ port: 3000, host: '127.0.0.1', inspect: () => ({ ok: false, detail: 'not a socket' }) });
    expect(result).toEqual({ ok: false, detail: 'not a socket' });
  });
});

describe('checkStateVersions', () => {
  const dirs = [];
  const createDataDir = () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-probe-state-'));
    dirs.push(dataDir);
    return dataDir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a data dir with no state files yet', () => {
    expect(checkStateVersions({ dataDir: createDataDir() })).toEqual({ ok: true, stateVersion: 1 });
  });

  it('accepts version 1 state and draining files', () => {
    const dataDir = createDataDir();
    const { statePath, drainingPath } = resolveManagedOpenCodePaths(dataDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, pid: 1 }));
    fs.writeFileSync(drainingPath, JSON.stringify({ version: 1, draining: [] }));
    expect(checkStateVersions({ dataDir }).ok).toBe(true);
  });

  it('refuses a state file at a version this build cannot read', () => {
    const dataDir = createDataDir();
    const { statePath } = resolveManagedOpenCodePaths(dataDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 999, pid: 1 }));
    const result = checkStateVersions({ dataDir });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('999');
  });

  it('refuses a malformed state file', () => {
    const dataDir = createDataDir();
    const { drainingPath } = resolveManagedOpenCodePaths(dataDir);
    fs.mkdirSync(path.dirname(drainingPath), { recursive: true });
    fs.writeFileSync(drainingPath, 'not json');
    expect(checkStateVersions({ dataDir }).ok).toBe(false);
  });
});

describe('createHandoffProbeGate', () => {
  const createGate = (overrides = {}) => {
    const sent = [];
    let handler = null;
    let disconnectHandler = null;
    const gate = createHandoffProbeGate({
      version: '2.6.0',
      dataDir: '/tmp/unused',
      previewOpenCode: async () => ({ decision: { action: 'adopt', reason: 'matches-state' }, openCodeVersion: '2.2.4' }),
      send: (message) => { sent.push(message); },
      onMessage: (fn) => { handler = fn; return () => { handler = null; }; },
      onDisconnect: (fn) => { disconnectHandler = fn; return () => { disconnectHandler = null; }; },
      checkListener: () => ({ ok: true, address: { address: '127.0.0.1', port: 3000 } }),
      checkState: () => ({ ok: true, stateVersion: 1 }),
      log: { log: vi.fn() },
      ...overrides,
    });
    return {
      gate,
      sent,
      deliver: (message) => handler?.(message),
      disconnect: () => disconnectHandler?.(),
      handlersCleared: () => handler === null && disconnectHandler === null,
    };
  };

  it('sends a hello with the version, protocol, state version and OpenCode decision, and resolves on go', async () => {
    const previewArgs = [];
    const { gate, sent, deliver } = createGate({
      previewOpenCode: async (args) => {
        previewArgs.push(args);
        return { decision: { action: 'adopt', reason: 'matches-state' }, openCodeVersion: '2.2.4' };
      },
    });
    const pending = gate({ port: 3000, bindHost: '127.0.0.1' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The preview needs the port this successor is about to serve on: the managed child
    // env it feeds into the launch fingerprint names that port in its callback URL.
    expect(previewArgs).toEqual([{ listenerPort: 3000 }]);
    expect(sent[0]).toEqual({
      type: HANDOFF_HELLO_MESSAGE,
      version: '2.6.0',
      handoffProtocol: 2,
      stateVersion: 1,
      opencode: { decision: 'adopt', reason: 'matches-state', version: '2.2.4' },
    });
    deliver({ type: HANDOFF_GO_MESSAGE });
    await expect(pending).resolves.toBeUndefined();
  });

  it('reports a failed listener check as a preflight-failed abort and throws it', async () => {
    const { gate, sent } = createGate({ checkListener: () => ({ ok: false, detail: 'wrong port' }) });
    await expect(gate({ port: 3000, bindHost: '127.0.0.1' })).rejects.toMatchObject({ handoffOutcome: 'preflight-failed', detail: 'wrong port' });
    expect(sent).toEqual([{ type: HANDOFF_ABORT_MESSAGE, reason: 'preflight-failed', detail: 'wrong port' }]);
  });

  it('reports a failed state check as a preflight-failed abort', async () => {
    const { gate, sent } = createGate({ checkState: () => ({ ok: false, detail: 'state.json is version 999' }) });
    await expect(gate({ port: 3000, bindHost: '127.0.0.1' })).rejects.toBeInstanceOf(HandoffProbeAbort);
    expect(sent[0]).toMatchObject({ type: HANDOFF_ABORT_MESSAGE, reason: 'preflight-failed' });
  });

  it('reports a preview failure as a preflight-failed abort', async () => {
    const { gate, sent } = createGate({
      previewOpenCode: async () => { throw new Error('binary missing'); },
    });
    await expect(gate({ port: 3000, bindHost: '127.0.0.1' })).rejects.toMatchObject({ handoffOutcome: 'preflight-failed' });
    expect(sent[0].detail).toContain('binary missing');
  });

  it('gives up when the predecessor closes the channel before answering', async () => {
    const { gate, sent, disconnect, handlersCleared } = createGate();
    const pending = gate({ port: 3000, bindHost: '127.0.0.1' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    disconnect();
    await expect(pending).rejects.toMatchObject({
      handoffOutcome: 'preflight-failed',
      detail: 'the predecessor closed the handoff channel before answering the hello',
    });
    expect(handlersCleared()).toBe(true);
  });

  it('throws the predecessor refusal with its reason and detail', async () => {
    const { gate, sent, deliver } = createGate();
    const pending = gate({ port: 3000, bindHost: '127.0.0.1' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    deliver({ type: HANDOFF_ABORT_MESSAGE, reason: 'incompatible', detail: 'protocol 3' });
    await expect(pending).rejects.toMatchObject({ handoffOutcome: 'incompatible', detail: 'protocol 3' });
  });
});
