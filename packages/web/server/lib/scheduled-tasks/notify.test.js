import { describe, expect, it } from 'vitest';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { parseLoopDefinition } from './loops.js';

const task = {
  id: 'task-notify', name: 'Digest', enabled: false,
  schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
  execution: { prompt: 'Summarize', providerID: 'openai', modelID: 'gpt-5' },
};

const setup = async () => {
  const root = await fs.mkdtemp('/tmp/opencode/scheduled-notify-');
  const createConfig = () => createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: root });
  return { root, createConfig, config: createConfig(), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
};

describe('scheduled-task notification preference', () => {
  it.each([undefined, null, 'invalid'])('normalizes legacy or unrecognized notify %s to finish without rewriting on read', async (notify) => {
    const { root, config, cleanup } = await setup();
    try {
      const raw = JSON.stringify({ version: 1, scheduledTasks: [{ ...task, execution: { ...task.execution, notify } }] });
      await fs.writeFile(path.join(root, 'proj.json'), raw);
      expect((await config.listScheduledTasks('proj'))[0].execution.notify).toBe('finish');
      expect(await fs.readFile(path.join(root, 'proj.json'), 'utf8')).toBe(raw);
    } finally { await cleanup(); }
  });

  it.each(['finish', 'attention'])('persists notify %s across reload, state writes and replacement', async (notify) => {
    const { root, config, createConfig, cleanup } = await setup();
    try {
      const saved = await config.upsertScheduledTask('proj', { ...task, execution: { ...task.execution, notify } });
      expect(saved.task.execution.notify).toBe(notify);
      await config.updateScheduledTaskState('proj', task.id, { lastStatus: 'success' });
      const reloaded = (await createConfig().listScheduledTasks('proj'))[0];
      expect(reloaded.execution.notify).toBe(notify);
      const replaced = await config.upsertScheduledTask('proj', { ...reloaded, name: 'Renamed' });
      expect(replaced.task.execution.notify).toBe(notify);
      const stored = JSON.parse(await fs.readFile(path.join(root, 'proj.json'), 'utf8'));
      expect(stored.scheduledTasks[0].execution.notify).toBe(notify);
      expect(stored.scheduledTasks[0].state.lastStatus).toBe('success');
    } finally { await cleanup(); }
  });

  it.each(['finish', 'attention'])('preserves notify %s through loop adoption and subsequent reconciliation', async (notify) => {
    const { root, config, createConfig, cleanup } = await setup();
    try {
      await config.upsertScheduledTask('proj', { ...task, execution: { ...task.execution, notify } });
      const filePath = path.join(root, 'digest.md');
      const writeLoop = (prompt) => fs.writeFile(filePath, `---\nname: Digest\nschedule: "0 8 * * *"\nmodel: openai/gpt-5\nnotify: ${notify === 'attention' ? 'finish' : 'attention'}\n---\n${prompt}\n`);
      await writeLoop('From loop');
      const reconcile = (runtime) => runtime.reconcileLoopTasks('proj', [{ filePath, scope: 'user', definition: parseLoopDefinition(filePath) }]);
      expect(parseLoopDefinition(filePath).execution).not.toHaveProperty('notify');
      const [adopted] = await reconcile(config);
      expect(adopted).toMatchObject({ id: task.id, loopFile: filePath, execution: { notify, prompt: 'From loop' } });
      await writeLoop('Updated loop');
      const [updated] = await reconcile(createConfig());
      expect(updated).toMatchObject({ id: task.id, execution: { notify, prompt: 'Updated loop' } });
    } finally { await cleanup(); }
  });

  it('defaults a newly discovered loop to finish', async () => {
    const { root, config, cleanup } = await setup();
    try {
      const [created] = await config.reconcileLoopTasks('proj', [{ filePath: path.join(root, 'new.md'), scope: 'user', definition: task }]);
      expect(created.execution.notify).toBe('finish');
    } finally { await cleanup(); }
  });
});
