import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { registerSettingsRoutes } from '../opencode/routes.js';
import { pickAgentSettings } from './settings-mirror.js';

it.each([false, true])('replaces absent mirror keys only on an agent server (%s)', async (agentServer) => {
  const root = await fs.mkdtemp('/tmp/opencode/mirror-route-');
  const createRuntime = () => createSettingsRuntime({
    fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: path.join(root, 'settings.json'),
    sanitizeProjects: (projects) => projects ?? [], sanitizeSettingsUpdate: (value) => value,
    mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => values ?? [], formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
  });
  const runtime = createRuntime();
  try {
    // Given stale mirrored fields whose ordinary sanitizer has no clear value,
    // alongside revoked session policy and a private agent-only field.
    await runtime.writeSettingsToDisk({ githubClientId: 'stale', lastSelectedModel: 'stale', lastUsedEfforts: { model: 'high' },
      permissionAutoAccept: { sessions: { ses_agent: 'ask' }, revision: 2 }, agentOnly: 'kept' });
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, { ...runtime, agentServer, formatSettingsResponse: (settings) => settings });
    // When a full owner mirror snapshot no longer carries those preferences.
    const response = await request(app).put('/api/config/settings').set('x-openchamber-settings-mirror', '1').send(pickAgentSettings({ locale: 'pt-BR' }));
    expect(response.status).toBe(200);
    const restarted = await createRuntime().readSettingsFromDiskMigrated();
    for (const key of ['githubClientId', 'lastSelectedModel', 'lastUsedEfforts']) {
      if (agentServer) expect(restarted).not.toHaveProperty(key);
      else expect(restarted).toHaveProperty(key);
    }
    // Then agent runtime state and non-mirrored settings remain untouched.
    expect(restarted.permissionAutoAccept.sessions.ses_agent).toBe('ask');
    expect(restarted.agentOnly).toBe('kept');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
