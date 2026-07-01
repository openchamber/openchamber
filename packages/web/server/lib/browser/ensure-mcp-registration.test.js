import { describe, expect, it } from 'vitest';
import {
  MANAGED_BROWSER_MCP_NAME,
  computeDesiredBrowserMcpEntry,
  ensureBrowserMcpRegistration,
} from './ensure-mcp-registration.js';

const makeFakeMcp = (initial = null) => {
  let store = initial;
  const calls = { create: 0, update: 0, delete: 0 };
  return {
    calls,
    getStore: () => store,
    getMcpConfig: (name) => (name === MANAGED_BROWSER_MCP_NAME ? store : null),
    createMcpConfig: (_name, cfg) => { store = { name: MANAGED_BROWSER_MCP_NAME, ...cfg }; calls.create += 1; },
    updateMcpConfig: (_name, cfg) => { store = { name: MANAGED_BROWSER_MCP_NAME, ...store, ...cfg }; calls.update += 1; },
    deleteMcpConfig: () => { store = null; calls.delete += 1; },
  };
};

describe('ensureBrowserMcpRegistration', () => {
  it('creates the entry when missing and enabled', () => {
    const mcp = makeFakeMcp(null);
    const res = ensureBrowserMcpRegistration({ enabled: true, port: 7456, token: 'tok', workingDirectory: '/w', mcp });
    expect(res).toEqual({ action: 'created', changed: true });
    expect(mcp.calls.create).toBe(1);
    expect(mcp.getStore().url).toContain('127.0.0.1:7456');
  });

  it('is a no-op (no restart) when the entry already matches — proves idempotency', () => {
    const desired = { name: MANAGED_BROWSER_MCP_NAME, ...computeDesiredBrowserMcpEntry({ port: 7456, token: 'tok' }) };
    const mcp = makeFakeMcp(desired);
    const res = ensureBrowserMcpRegistration({ enabled: true, port: 7456, token: 'tok', workingDirectory: '/w', mcp });
    expect(res).toEqual({ action: 'noop', changed: false });
    expect(mcp.calls.create).toBe(0);
    expect(mcp.calls.update).toBe(0);
  });

  it('updates exactly once on drift (port or token change)', () => {
    const stale = { name: MANAGED_BROWSER_MCP_NAME, ...computeDesiredBrowserMcpEntry({ port: 9999, token: 'old' }) };
    const mcp = makeFakeMcp(stale);
    const res = ensureBrowserMcpRegistration({ enabled: true, port: 7456, token: 'new', workingDirectory: '/w', mcp });
    expect(res).toEqual({ action: 'updated', changed: true });
    expect(mcp.calls.update).toBe(1);
    expect(mcp.getStore().headers.Authorization).toBe('Bearer new');
  });

  it('deletes the managed entry when disabled', () => {
    const desired = { name: MANAGED_BROWSER_MCP_NAME, ...computeDesiredBrowserMcpEntry({ port: 7456, token: 'tok' }) };
    const mcp = makeFakeMcp(desired);
    const res = ensureBrowserMcpRegistration({ enabled: false, port: 7456, token: 'tok', workingDirectory: '/w', mcp });
    expect(res).toEqual({ action: 'deleted', changed: true });
    expect(mcp.calls.delete).toBe(1);
    expect(mcp.getStore()).toBeNull();
  });

  it('is a no-op when disabled and nothing is registered', () => {
    const mcp = makeFakeMcp(null);
    const res = ensureBrowserMcpRegistration({ enabled: false, port: 7456, token: 'tok', workingDirectory: '/w', mcp });
    expect(res).toEqual({ action: 'noop', changed: false });
    expect(mcp.calls.delete).toBe(0);
  });
});
