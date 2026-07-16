import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { createCodexProjectRegistrar } from './project-registrar.js';

describe('Codex project registrar', () => {
  it('merges available projects into the latest settings snapshot', async () => {
    let settings = {
      theme: 'dark',
      projects: [{ id: 'existing', path: 'C:\\existing', addedAt: 1, lastOpenedAt: 1 }],
    };
    const updateSettings = vi.fn(async (createChanges) => {
      const changes = await createChanges(settings);
      settings = { ...settings, ...changes };
      return settings;
    });
    const registerProjects = createCodexProjectRegistrar({
      fsPromises: {
        stat: vi.fn(async (projectPath) => {
          if (projectPath === 'C:\\missing') throw new Error('missing');
          return { isDirectory: () => true };
        }),
      },
      path: path.win32,
      updateSettings,
      sanitizeProjects: (projects) => projects,
    });

    const result = await registerProjects(['C:\\existing', 'C:\\new', 'C:\\missing']);

    expect(result).toEqual({ added: 1, existing: 1, unavailable: 1 });
    expect(settings.theme).toBe('dark');
    expect(settings.projects.map((project) => project.path)).toEqual(['C:\\existing', 'C:\\new']);
  });
});
