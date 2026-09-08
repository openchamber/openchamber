import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { useUIStore } from '@/stores/useUIStore';
import {
  AUTO_SAVE_KEYS,
  DESKTOP_SHELL_KEYS,
  LOCAL_DEVICE_KEYS,
  MIRRORED_KEYS,
  SETTINGS_KEYS,
  SETTINGS_REGISTRY,
  applySettingsToStores,
  buildSettingsRegistrySnapshot,
  parseSettingsDocument,
} from './registry';
import { renderSettingsRegistrySnapshot, SETTINGS_REGISTRY_SNAPSHOT_PATHS } from './registry-snapshot';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

describe('settings registry', () => {
  test('every key lives in exactly one table', () => {
    const all = [...SETTINGS_KEYS, ...LOCAL_DEVICE_KEYS, ...DESKTOP_SHELL_KEYS];
    expect(new Set(all).size).toBe(all.length);
  });

  test('covers every key the ui-store persists, under its settings name', () => {
    const partialize = useUIStore.persist.getOptions().partialize;
    expect(partialize).toBeTruthy();
    // zustand types the persisted slice loosely; only its key names matter here.
    const persistedKeys = Object.keys(z.object({}).passthrough().parse(partialize!(useUIStore.getInitialState())));
    // The store's name for the shared `draftStarters` field.
    const aliases = new Map([['globalDraftStarters', 'draftStarters']]);
    const known = new Set<string>([...SETTINGS_KEYS, ...LOCAL_DEVICE_KEYS]);
    const missing = persistedKeys.map((key) => aliases.get(key) ?? key).filter((key) => !known.has(key));
    expect(missing).toEqual([]);
  });

  test('per-surface storage is a profile-only marker', () => {
    for (const key of SETTINGS_KEYS) {
      if (SETTINGS_REGISTRY[key].perSurface) {
        expect(SETTINGS_REGISTRY[key].scope).toBe('profile');
      }
    }
  });

  test('computed and secret fields never reach the mirror; computed ones are never auto-saved', () => {
    for (const key of MIRRORED_KEYS) {
      expect(SETTINGS_REGISTRY[key].secret).toBe(undefined);
      expect(SETTINGS_REGISTRY[key].computed).toBe(undefined);
      expect(SETTINGS_REGISTRY[key].scope).not.toBe('device');
    }
    for (const key of AUTO_SAVE_KEYS) {
      expect(SETTINGS_REGISTRY[key].computed).toBe(undefined);
    }
  });

  test('parses a document at the boundary: unknown keys dropped, rejected values absent, legacy keys mapped', () => {
    const parsed = parseSettingsDocument({
      fontSize: 15,
      toolJsonViewMode: 'invalid',
      queueModeEnabled: false,
      gitProviderId: 'anthropic',
      markdownDisplayMode: 'x',
      autoDeleteAfterDays: 900,
      sttProvider: 'server',
    });
    expect(parsed).toEqual({
      fontSize: 15,
      followUpBehavior: 'steer',
      queueModeEnabled: false,
      autoDeleteAfterDays: 365,
      sttProvider: 'openai-compatible',
    });
    expect(parseSettingsDocument(null)).toBeNull();
    expect(parseSettingsDocument([])).toBeNull();
  });

  test('applies only the fields a snapshot carries and leaves the rest alone', () => {
    useUIStore.getState().setTerminalShell('fish');
    useUIStore.getState().setShowReasoningTraces(true);
    applySettingsToStores({ showReasoningTraces: false });
    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('applies the hidden-sections list together with its explicit marker', () => {
    applySettingsToStores({ workStatusHiddenSections: ['mcp', 'telemetry'] });
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(false);
    applySettingsToStores({ workStatusHiddenSections: ['mcp', 'telemetry'], workStatusHiddenSectionsExplicit: true });
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp', 'telemetry']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(true);
  });

  test('the checked-in JSON snapshots match the registry (run `bun run settings-registry:generate`)', () => {
    const rendered = renderSettingsRegistrySnapshot();
    for (const relativePath of SETTINGS_REGISTRY_SNAPSHOT_PATHS) {
      expect(readFileSync(resolve(repoRoot, relativePath), 'utf8')).toBe(rendered);
    }
  });

  test('the snapshot names every key of every table', () => {
    const snapshot = buildSettingsRegistrySnapshot();
    const keys = Object.keys(snapshot.fields);
    expect(keys.length).toBe(SETTINGS_KEYS.length + LOCAL_DEVICE_KEYS.length + DESKTOP_SHELL_KEYS.length);
    for (const key of LOCAL_DEVICE_KEYS) expect(snapshot.fields[key]).toEqual({ scope: 'device', local: true });
    for (const key of DESKTOP_SHELL_KEYS) expect(snapshot.fields[key].owner).toBe('desktop-shell');
  });
});
