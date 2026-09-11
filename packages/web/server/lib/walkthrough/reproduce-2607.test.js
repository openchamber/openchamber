import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Regression for https://github.com/openchamber/openchamber/issues/2607
// "[Bug] Why say so?" (walkthrough panel)
//
// Before the fix, a walkthrough small model whose provider had no usable login
// reported readiness ready:true, then generation returned HTTP 500 with the raw
// message `No OpenCode login found for provider "deepseek"` — shown in the
// error banner above the "No walkthrough yet" empty state.
//
// After the fix: readiness refuses with `no-provider-login`, and generation
// answers 401 with the same structured code so the UI can show a blocker.
// ---------------------------------------------------------------------------

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-2607-'));
process.env.HOME = TEMP_HOME;
process.env.OPENCHAMBER_DATA_DIR = path.join(TEMP_HOME, '.config', 'openchamber');

const CATALOG = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: 'deepseek-flash',
        limit: { context: 128_000 },
      },
    },
  },
};

vi.mock('../../opencode/models-metadata.js', () => ({
  getModelsMetadata: vi.fn(async () => ({ metadata: CATALOG, fromCache: false })),
}));

const SOURCE = { kind: 'working-tree', scope: 'all' };
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-2607-'));

const setupGitRepo = () => {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
    } catch (error) {
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.toString() ?? error.message}`);
    }
  };

  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  run(['add', 'src/a.ts']);
  run(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
};

let walkthrough;
let callSmallModel;

describe('issue 2607 — walkthrough blocks unauthenticated providers', () => {
  beforeAll(async () => {
    setupGitRepo();
    fs.writeFileSync(
      path.join(REPO_DIR, 'opencode.json'),
      JSON.stringify({ small_model: 'deepseek/deepseek-v4-flash' }, null, 2),
      'utf8',
    );

    walkthrough = await import('./index.js');
    callSmallModel = await import('../small-model/call.js');
  });

  afterAll(() => {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true });
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  });

  it('resolves the deepseek model but reports not ready without a login', async () => {
    const result = await walkthrough.getWalkthrough({ directory: REPO_DIR, source: SOURCE });

    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.reason).toBe('no-provider-login');
    // Unusable models must not be offered as the current selection.
    expect(result.readiness.model).toBeUndefined();
  });

  it('callSmallModel throws a structured no-provider-login error', async () => {
    const error = await callSmallModel.callSmallModel({
      auth: {},
      catalog: CATALOG,
      workingDirectory: REPO_DIR,
      providerID: 'deepseek',
      modelID: 'deepseek-v4-flash',
      prompt: 'x',
    }).then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('No OpenCode login found for provider "deepseek"');
    expect(error.code).toBe('no-provider-login');
    expect(error.statusCode).toBe(401);
  });

  it('generateWalkthrough rejects with structured no-provider-login', async () => {
    const error = await walkthrough.generateWalkthrough({ directory: REPO_DIR, source: SOURCE })
      .then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('no-provider-login');
    expect(error.statusCode).toBe(401);
    expect(error.model).toMatchObject({ providerID: 'deepseek', modelID: 'deepseek-v4-flash' });
  });

  it('answers the generate route with HTTP 401 and code no-provider-login', async () => {
    const service = { ...walkthrough, getPullRequestDiff: async () => { throw new Error('not used'); } };
    const app = express();
    app.use(express.json());
    const { registerWalkthroughRoutes } = await import('./routes.js');
    registerWalkthroughRoutes(app, { getWalkthroughService: async () => service });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/api/walkthrough/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: REPO_DIR, source: SOURCE }),
      });
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe('no-provider-login');
      expect(body.model).toMatchObject({ providerID: 'deepseek', modelID: 'deepseek-v4-flash' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
