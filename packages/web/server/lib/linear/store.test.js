import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LinearIntegrationStore, normalizeLinearSettings, LINEAR_DEFAULT_TRIGGER_LABEL } from './store.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-store-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createStore() {
  return new LinearIntegrationStore({ filePath: path.join(tmpDir, 'linear-integration.json') });
}

describe('LinearIntegrationStore', () => {
  it('starts disconnected with default settings', () => {
    const store = createStore();
    const state = store.read();
    expect(state.apiKey).toBeNull();
    expect(state.viewer).toBeNull();
    expect(state.settings.triggerLabel).toBe(LINEAR_DEFAULT_TRIGGER_LABEL);
    expect(state.settings.postStatusUpdates).toBe(true);
    expect(state.settings.autoStartEnabled).toBe(false);
  });

  it('round-trips auth and identity', () => {
    const store = createStore();
    store.setAuth({
      apiKey: 'lin_api_secret',
      viewer: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
      organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    });
    const state = createStore().read();
    expect(state.apiKey).toBe('lin_api_secret');
    expect(state.viewer).toEqual({ id: 'user-1', name: 'Ada', email: 'ada@example.com' });
    expect(state.organization).toEqual({ id: 'org-1', name: 'Acme', urlKey: 'acme' });
    expect(typeof state.connectedAt).toBe('number');
  });

  it('clearAuth removes the key but preserves settings', () => {
    const store = createStore();
    store.setAuth({ apiKey: 'lin_api_secret', viewer: { id: 'user-1' } });
    store.updateSettings({ defaultProjectId: 'proj-1', autoStartEnabled: true });
    store.clearAuth();
    const state = store.read();
    expect(state.apiKey).toBeNull();
    expect(state.viewer).toBeNull();
    expect(state.settings.defaultProjectId).toBe('proj-1');
    expect(state.settings.autoStartEnabled).toBe(true);
  });

  it('merges partial settings updates and drops unknown keys', () => {
    const store = createStore();
    store.updateSettings({ defaultProjectId: 'proj-1' });
    const settings = store.updateSettings({ triggerLabel: 'agent', bogus: true });
    expect(settings.defaultProjectId).toBe('proj-1');
    expect(settings.triggerLabel).toBe('agent');
    expect('bogus' in settings).toBe(false);
  });

  it('survives a corrupt file by falling back to defaults', () => {
    const filePath = path.join(tmpDir, 'linear-integration.json');
    fs.writeFileSync(filePath, '{not json', 'utf8');
    const store = new LinearIntegrationStore({ filePath });
    expect(store.read().apiKey).toBeNull();
    expect(store.read().settings.triggerLabel).toBe(LINEAR_DEFAULT_TRIGGER_LABEL);
  });
});

describe('normalizeLinearSettings', () => {
  it('drops invalid and duplicate team mappings', () => {
    const settings = normalizeLinearSettings({
      teamMappings: [
        { teamId: 't1', teamKey: 'ENG', projectId: 'p1' },
        { teamId: 't1', teamKey: 'ENG', projectId: 'p2' },
        { teamId: 't2' },
        null,
      ],
    });
    expect(settings.teamMappings).toEqual([
      { teamId: 't1', teamKey: 'ENG', teamName: null, projectId: 'p1' },
    ]);
  });

  it('falls back to the default trigger label for blank values', () => {
    expect(normalizeLinearSettings({ triggerLabel: '  ' }).triggerLabel).toBe(
      LINEAR_DEFAULT_TRIGGER_LABEL,
    );
  });
});
