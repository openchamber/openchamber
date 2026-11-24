import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerHealthRoute, summarizeStartError } from './health-route.js';

// The shapes lifecycle.ts records after an early exit at startup and a managed restart.
const snapshot = () => ({
  openCodePort: 4096,
  openCodeRunning: false,
  openCodeSecureConnection: false,
  openCodeAuthSource: 'password',
  openCodeApiPrefix: '',
  openCodeApiPrefixDetected: true,
  isOpenCodeReady: false,
  lastOpenCodeError: 'OpenCode process exited before serving with code 1. Binary used: /home/me/.opencode/bin/opencode. stderr: Error: cannot read /home/me/project/opencode.json',
  lastOpenCodeHealthFailure: {
    class: 'connection_refused',
    detail: 'connect ECONNREFUSED 127.0.0.1:4096',
    at: '2026-01-01T00:00:00.000Z',
    source: 'periodic',
  },
  lastOpenCodeRestartDiagnostics: {
    reason: 'periodic-health-failure',
    healthFailure: { class: 'timeout', detail: 'GET http://127.0.0.1:4096/global/health timed out', at: '2026-01-01T00:00:00.000Z', source: 'periodic' },
    process: { pid: 4242, exitCode: null, signalCode: null, stderrTail: 'panic at /home/me/project', alive: true },
    busySessionCount: 2,
    at: '2026-01-01T00:01:00.000Z',
  },
  lastOpenCodeLaunchDiagnostics: { binary: '/home/me/.opencode/bin/opencode', sourceBinary: '/home/me/.opencode/bin/opencode', cwd: '/home/me' },
  lastManagedOpenCodeProcess: { pid: 4242, exitCode: null, signalCode: null, stderrTail: 'secret' },
  opencodeBinaryResolved: '/home/me/.opencode/bin/opencode',
  opencodeBinarySource: 'path',
  opencodeLaunchBinary: '/home/me/.opencode/bin/opencode',
  opencodeLaunchArgs: ['serve', '--port', '4096'],
  opencodeLaunchWrapperType: 'node-launcher',
  opencodeViaWsl: false,
  opencodeWslBinary: null,
  opencodeWslPath: null,
  opencodeWslDistro: null,
  nodeBinaryResolved: '/usr/bin/node',
  bunBinaryResolved: '/usr/bin/bun',
  desktopNotifyEnabled: false,
  apiOnly: false,
  futureMachineField: '/home/me/private',
});

const dependencies = (overrides = {}) => ({
  getHealthSnapshot: snapshot,
  resolveServerId: async () => 'srv-1',
  openchamberVersion: '1.2.3',
  runtimeName: 'web',
  compatibility: { apiVersion: 1 },
  isLocalPeer: () => true,
  ...overrides,
});

describe('health route', () => {
  it('answers a non-local caller with liveness, readiness and safe summaries only', async () => {
    const app = express();
    registerHealthRoute({ ...dependencies({ isLocalPeer: () => false }), app });

    const response = await request(app).get('/health').expect(200);
    const { timestamp, ...rest } = response.body;
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
    expect(rest).toEqual({
      status: 'ok',
      openchamberVersion: '1.2.3',
      runtime: 'web',
      compatibility: { apiVersion: 1 },
      serverId: 'srv-1',
      openCodePort: 4096,
      openCodeRunning: false,
      isOpenCodeReady: false,
      openCodeSecureConnection: false,
      openCodeAuthSource: 'password',
      lastOpenCodeError: 'OpenCode process exited before serving with code 1',
      lastOpenCodeHealthFailure: { class: 'connection_refused', at: '2026-01-01T00:00:00.000Z' },
      lastOpenCodeRestartDiagnostics: { at: '2026-01-01T00:01:00.000Z', busySessionCount: 2 },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/home\/me|4242|secret|ECONNREFUSED/);
  });

  it('tells a non-local caller that OpenCode is the shared service', async () => {
    const app = express();
    registerHealthRoute({
      ...dependencies({ isLocalPeer: () => false, getHealthSnapshot: () => ({ ...snapshot(), opencodeBinarySource: 'shared-service' }) }),
      app,
    });

    const response = await request(app).get('/health').expect(200);
    expect(response.body.opencodeBinarySource).toBe('shared-service');
  });

  it('answers a local caller with every snapshot field', async () => {
    const app = express();
    registerHealthRoute({ ...dependencies(), app });

    const response = await request(app).get('/health').expect(200);
    expect(response.body.opencodeBinaryResolved).toBe('/home/me/.opencode/bin/opencode');
    expect(response.body.lastOpenCodeError).toContain('Binary used');
    expect(response.body.lastOpenCodeRestartDiagnostics.process.pid).toBe(4242);
    expect(response.body.futureMachineField).toBe('/home/me/private');
    expect(response.body.serverId).toBe('srv-1');
  });

  it('summarizes startup errors without paths or captured output', () => {
    expect(summarizeStartError(null)).toBeNull();
    expect(summarizeStartError('spawn /home/me/bin/opencode ENOENT')).toBe('OpenCode binary not found (ENOENT)');
    expect(summarizeStartError('OpenCode process exited before serving with signal SIGKILL. Binary used: /x.')).toBe('OpenCode process exited before serving with signal SIGKILL');
    expect(summarizeStartError('token=secret-123 at /home/me')).toBe('OpenCode failed to start; details are available on the server machine');
    expect(summarizeStartError('   ')).toBeNull();
  });

  it('keeps the reason of a configured binary error and drops its path', () => {
    const hint = 'OpenChamber needs the standalone opencode CLI. Install it and set settings.opencodeBinary to the CLI path, for example ~/.opencode/bin/opencode, or leave the setting empty to use PATH lookup.';
    expect(summarizeStartError(`Configured OpenCode binary not found: /home/me/EACCES/opencode. ${hint}`))
      .toBe(`Configured OpenCode binary not found. ${hint}`);
    expect(summarizeStartError(`Configured OpenCode binary points at the macOS desktop app bundle, not the CLI: /Applications/OpenCode.app/Contents/MacOS/OpenCode. ${hint}`))
      .toBe(`Configured OpenCode binary points at the macOS desktop app bundle, not the CLI. ${hint}`);
    expect(summarizeStartError(`Configured OpenCode binary directory does not contain an executable opencode: /home/me/bin. ${hint}`))
      .toBe(`Configured OpenCode binary directory does not contain an executable opencode. ${hint}`);
  });

  it('classifies a spawn failure by its code, not by a path that names another code', () => {
    expect(summarizeStartError('spawn /home/EACCES/opencode ENOENT')).toBe('OpenCode binary not found (ENOENT)');
    expect(summarizeStartError('spawn /home/ENOENT/opencode EACCES')).toBe('OpenCode binary is not executable (EACCES)');
  });
});
