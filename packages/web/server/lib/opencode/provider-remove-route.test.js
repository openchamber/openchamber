import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

// The global config paths are frozen when the modules load, so point
// XDG_CONFIG_HOME at a scratch directory before importing them.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-remove-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
delete process.env.OPENCODE_CONFIG;

const { registerOpenCodeRoutes } = await import('./routes.js');
const { getProviderSources, removeProviderConfig } = await import('./providers.js');

const configDir = path.join(root, 'xdg', 'opencode');
const projectDir = path.join(root, 'project');
const entry = {
  name: 'Oops',
  package: 'aisdk:@ai-sdk/openai-compatible',
  settings: { baseURL: 'https://oops.example.com/v1' },
  models: { m: { name: 'M' } },
};
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
};
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    resolveProjectDirectory: vi.fn(async () => ({ directory: projectDir })),
    getProviderSources,
    removeProviderConfig,
  });
  return app;
};

describe('DELETE /api/provider/:providerId/auth?scope=all', () => {
  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it('removes the provider from both global files and the project config', async () => {
    // OpenCode merges opencode.json and opencode.jsonc, so an entry left in
    // either one keeps the provider listed.
    writeJson(path.join(configDir, 'opencode.json'), { providers: { oops: entry, keep: entry } });
    writeJson(path.join(configDir, 'opencode.jsonc'), { providers: { oops: entry } });
    writeJson(path.join(projectDir, 'opencode.json'), { providers: { oops: entry } });

    const response = await request(createApp())
      .delete(`/api/provider/oops/auth?scope=all&directory=${encodeURIComponent(projectDir)}`)
      .expect(200);

    expect(response.body.removed).toBe(true);
    const { sources } = getProviderSources('oops', projectDir);
    expect([sources.user.exists, sources.project.exists, sources.custom.exists]).toEqual([false, false, false]);
    expect(readJson(path.join(configDir, 'opencode.json')).providers).toEqual({ keep: entry });
  });

  it('answers removed: false when no layer defines the provider', async () => {
    writeJson(path.join(configDir, 'opencode.json'), { providers: { keep: entry } });

    // "constructor" names a value every object inherits; it once read as an entry
    // that delete never removed, so the removal looped forever.
    for (const providerId of ['oops', 'constructor']) {
      const response = await request(createApp()).delete(`/api/provider/${providerId}/auth?scope=all`).expect(200);
      expect(response.body.removed).toBe(false);
    }
    expect(readJson(path.join(configDir, 'opencode.json')).providers).toEqual({ keep: entry });
  });
});
