import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { createBotsConfig } from './config.js';
import { botTaskFor } from './events.js';
import { createBotScheduler } from './scheduler.js';

const root = await fs.mkdtemp('/tmp/opencode/bot-scheduler-driver-');
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let runtime;
try {
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME;
  const projectConfigRuntime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'projects') });
  const config = createBotsConfig({ projectConfigRuntime });
  const dispatches = [];
  let sessionRequests = 0;
  globalThis.fetch = async () => {
    sessionRequests += 1;
    throw new Error('Driver forbids OpenCode requests');
  };
  runtime = createScheduledTasksRuntime({
    projectConfigRuntime, listProjects: async () => [{ id: 'project', path: repo }],
    buildOpenCodeUrl: () => 'http://127.0.0.1:9999', getOpenCodeAuthHeaders: () => ({}),
    // Explicit deterministic coordinator substitute; no discovery or provider claim.
    runBot: async (projectId, botId, occurrence) => {
      dispatches.push({ projectId, botId, occurrence });
      return { items: [], skipped: true };
    },
    logger: { info() {}, warn() {} },
  });
  const scheduler = createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime: runtime });
  const service = createScheduledTaskService({
    projectConfigRuntime, scheduledTasksRuntime: runtime,
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project', path: repo }] }),
    sanitizeProjects: (projects) => projects,
  });
  const settings = await config.update('project', { definitions: [{ id: 'triage', name: 'Triage', mission: 'Investigate bugs.' }] });
  await scheduler.sync('project', settings.definitions.map(botTaskFor));
  const [listed] = await service.list('project');
  assert.equal(listed.botId, 'triage');
  assert.equal(listed.botManaged, true);
  assert.equal(listed.enabled, false);
  const run = await service.run('project', listed.id);
  assert.equal(run.sessionId, undefined);
  assert.equal(run.task.state.lastStatus, 'skipped');
  assert.equal(sessionRequests, 0);
  assert.equal(dispatches.length, 1);
  let refused = 0;
  for (const mutation of [
    () => service.upsert('project', { ...listed, name: 'Hijacked' }),
    () => service.setEnabled('project', listed.id, true),
    () => service.remove('project', listed.id),
  ]) {
    await assert.rejects(mutation, (error) => error.statusCode === 409);
    refused += 1;
  }
  await config.update('project', { definitions: [] });
  await scheduler.sync('project', []);
  assert.deepEqual(await service.list('project'), []);
  console.log(JSON.stringify({ mode: 'real config, scheduler and service; deterministic bot hook; no live OpenCode or providers',
    ownership: { botId: listed.botId, botManaged: listed.botManaged }, status: run.task.state.lastStatus,
    dispatches, sessionRequests, refusedMutations: refused, staleRows: 0 }, null, 2));
} finally {
  runtime?.stop();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await fs.rm(root, { recursive: true, force: true });
}
