import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSettingsRuntime } from '../../../web/server/lib/opencode/settings-runtime.js';
import { createProjectIdFromPath } from '@/lib/projectId';
import { useProjectsStore } from './useProjectsStore';
import { useDirectoryStore } from './useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { updateDesktopSettings } from '@/lib/persistence';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
const originalProjects = useProjectsStore.getState();
const originalDirectory = useDirectoryStore.getState();
const originalSDKDirectory = opencodeClient.getDirectory();
const events = new EventTarget();
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  setTimeout: (...args) => setTimeout(...args), clearTimeout: (timer) => clearTimeout(timer),
} });
let root;
let runtime;
let settingsFilePath;
let automatic;
let manual;
let holdManual;
let releaseManual;
let manualStarted;
let manualFinished;
let markManualStarted;
let markManualFinished;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-session-project-race-'));
  settingsFilePath = path.join(root, 'settings.json');
  automatic = { id: createProjectIdFromPath(path.join(root, 'A')), path: path.join(root, 'A') };
  manual = path.join(root, 'B');
  await fs.mkdir(automatic.path);
  await fs.mkdir(manual);
  await fs.writeFile(settingsFilePath, '{"projects":[]}');
  runtime = createSettingsRuntime({
    fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
  holdManual = false;
  const gate = new Promise((resolve) => { releaseManual = resolve; });
  manualStarted = new Promise((resolve) => { markManualStarted = resolve; });
  manualFinished = new Promise((resolve) => { markManualFinished = resolve; });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://project-race.test', runtimeKey: root });
  useProjectsStore.setState({ projects: [], activeProjectId: null, discoverProjectIcon: async () => ({ ok: true }) });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/api/projects/session-directory') {
      const project = await runtime.registerSessionProject((projects) => projects.find((entry) => entry.id === automatic.id) ?? automatic);
      return Response.json({ project });
    }
    if (url.pathname === '/api/config/settings' && init?.method === 'PUT') {
      const changes = JSON.parse(String(init.body));
      const staleManualWrite = changes.projects?.length === 1 && changes.projects[0].path === manual;
      if (holdManual && staleManualWrite) { markManualStarted(); await gate; }
      const updated = await runtime.persistSettings(changes);
      if (holdManual && staleManualWrite) markManualFinished();
      return Response.json(updated);
    }
    return new Response(null, { status: 503 });
  };
  jest.useFakeTimers();
});
afterEach(async () => {
  releaseManual();
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  useProjectsStore.setState(originalProjects, true);
  useDirectoryStore.setState(originalDirectory, true);
  opencodeClient.setDirectory(originalSDKDirectory);
  await fs.rm(root, { recursive: true, force: true });
});
afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('manual and automatic project registration', () => {
  for (const inFlight of [false, true]) {
    test(`keeps both disk entries when the older manual snapshot is ${inFlight ? 'in flight' : 'debounced'}`, async () => {
      holdManual = inFlight;
      await useProjectsStore.getState().addProject(manual);
      if (inFlight) {
        jest.advanceTimersByTime(200);
        await manualStarted;
      }
      expect(await useProjectsStore.getState().adoptSessionProject('automatic', automatic.path, () => true)).toBe(true);
      expect(JSON.parse(await fs.readFile(settingsFilePath, 'utf8')).projects.map((entry) => entry.path)).toEqual([automatic.path]);
      if (inFlight) { releaseManual(); await manualFinished; }
      // Join the existing flush with an unrelated field. This must not repair
      // the registry on the test's behalf by writing projects itself.
      const flushed = updateDesktopSettings({ lightThemeId: root });
      jest.advanceTimersByTime(200);
      expect(await flushed).toEqual({ ok: true });
      const persisted = JSON.parse(await fs.readFile(settingsFilePath, 'utf8'));
      expect(persisted.projects.map((entry) => entry.path).sort()).toEqual([automatic.path, manual].sort());
    });
  }
});
