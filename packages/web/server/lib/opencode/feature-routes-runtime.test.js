import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeatureRoutesRuntime } from './feature-routes-runtime.js';
import { createTrackerRegistry } from '../trackers/registry.js';

const noop = () => {};

describe('feature-routes-runtime', () => {
  it('should not register /api/ci-loop routes', async () => {
    const runtime = createFeatureRoutesRuntime({ clientReloadDelayMs: 0, trackers: createTrackerRegistry([]) });
    const app = express();
    await runtime.registerRoutes(app, {
      crypto: { randomUUID: noop },
      fs,
      os,
      path,
      openchamberDataDir: '/tmp/opencode-ci-loop-test-data',
      openchamberUserConfigRoot: '/tmp/opencode-ci-loop-test-config',
      fsPromises: fs.promises,
      spawn: noop,
      createFsSearchRuntime: () => ({}),
      normalizeDirectoryPath: noop,
      resolveProjectDirectory: noop,
      resolveOptionalProjectDirectory: noop,
      validateDirectoryPath: noop,
      readSettingsFromDisk: noop,
      readSettingsFromDiskMigrated: noop,
      persistSettings: noop,
      formatSettingsResponse: noop,
      getOwnPorts: noop,
      buildOpenCodeUrl: noop,
      getOpenCodeAuthHeaders: noop,
      getOpenCodePort: noop,
      waitForOpenCodeReady: noop,
      writeSseEvent: noop,
      devServerScanner: {},
      projectConfigRuntime: {},
      projectContextRuntime: {},
      agentMemoryRuntime: {},
      sessionKnowledgeRuntime: {},
      scheduledTasksRuntime: {},
      scheduledTaskService: {},
      openChamberSessionService: {},
      openChamberControlService: {},
      permissionAutoAcceptRuntime: {},
      messageQueueRuntime: {},
      routingRuntime: {},
      getOpenChamberEventClients: noop,
      emitSessionCreatedEvent: noop,
      refreshOpenCodeAfterConfigChange: noop,
      getOpenCodeResolutionSnapshot: noop,
      getOpenCodeUpgradeCapability: noop,
      upgradeOpenCodeCli: noop,
      getOpenCodeCompatibility: noop,
      installOpenCodeV2: noop,
      resolveGitBinaryForSpawn: () => 'git',
      sanitizeProjects: noop,
      sanitizeSkillCatalogs: noop,
      isUnsafeSkillRelativePath: noop,
    });

    const response = await request(app).get('/api/ci-loop/session/x');
    expect(response.status).toBe(404);
  });
});
