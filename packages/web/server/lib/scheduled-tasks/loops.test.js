import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { parseLoopDefinition, discoverLoops, discoverLoopFiles } from './loops.js';

const createProject = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loops-'));
  const projectPath = path.join(tempRoot, 'repo');
  await mkdir(projectPath, { recursive: true });
  await mkdir(path.join(projectPath, '.git'), { recursive: true });
  return {
    projectPath,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

const writeLoop = async (projectPath, fileName, content) => {
  const dir = path.join(projectPath, '.agents', 'loops');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, 'utf8');
};

describe('parseLoopDefinition', () => {
  it('maps frontmatter and body to the scheduled-task definition shape', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      await writeLoop(projectPath, 'digest.md', `---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: anthropic/claude-sonnet-4-5
agent: plan
timezone: Europe/Kyiv
---
Summarize repository changes since yesterday.
`);

      const definition = parseLoopDefinition(path.join(projectPath, '.agents', 'loops', 'digest.md'));

      expect(definition).toEqual({
        name: 'daily-digest',
        enabled: true,
        schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'Europe/Kyiv' },
        execution: {
          prompt: 'Summarize repository changes since yesterday.',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          agent: 'plan',
        },
      });
    } finally {
      await cleanup();
    }
  });

  it('splits model ids containing a slash on the first separator', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      const filePath = path.join(projectPath, 'loop.md');
      await writeFile(filePath, `---
name: nested-model
schedule: "0 8 * * 1"
model: openai/gpt-5
---
Run weekly checks.
`, 'utf8');

      const definition = parseLoopDefinition(filePath);

      expect(definition.execution.providerID).toBe('openai');
      expect(definition.execution.modelID).toBe('gpt-5');
      expect(definition.enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('defaults enabled to false and omits optional fields', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      const filePath = path.join(projectPath, 'loop.md');
      await writeFile(filePath, `---
name: minimal
schedule: "*/30 * * * *"
model: openai/gpt-5
---
Run every half hour.
`, 'utf8');

      const definition = parseLoopDefinition(filePath);

      // Loops only run when the file explicitly enables them: discovery of
      // repository content must never auto-execute scheduled sessions.
      expect(definition.enabled).toBe(false);
      expect(definition.schedule).toEqual({ kind: 'cron', cron: '*/30 * * * *' });
      expect(definition.execution.agent).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('honors an explicit enabled: true in the frontmatter', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      const filePath = path.join(projectPath, 'loop.md');
      await writeFile(filePath, `---
name: explicit-enabled
schedule: "*/30 * * * *"
model: openai/gpt-5
enabled: true
---
Run every half hour.
`, 'utf8');

      expect(parseLoopDefinition(filePath).enabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('returns null for files missing required frontmatter fields', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const noName = path.join(projectPath, 'noname.md');
        await writeFile(noName, `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Prompt only.
`, 'utf8');
        expect(parseLoopDefinition(noName)).toBeNull();

        const noSchedule = path.join(projectPath, 'noschedule.md');
        await writeFile(noSchedule, `---
name: no-schedule
model: openai/gpt-5
---
Prompt only.
`, 'utf8');
        expect(parseLoopDefinition(noSchedule)).toBeNull();

        const noModel = path.join(projectPath, 'nomodel.md');
        await writeFile(noModel, `---
name: no-model
schedule: "0 9 * * *"
---
Prompt only.
`, 'utf8');
        expect(parseLoopDefinition(noModel)).toBeNull();

        const malformed = path.join(projectPath, 'malformed.md');
        await writeFile(malformed, 'not a markdown frontmatter file at all', 'utf8');
        expect(parseLoopDefinition(malformed)).toBeNull();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  it('treats a missing body as an invalid loop', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      const filePath = path.join(projectPath, 'empty-body.md');
      await writeFile(filePath, `---
name: empty-body
schedule: "0 9 * * *"
model: openai/gpt-5
---
`, 'utf8');

      expect(parseLoopDefinition(filePath)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('rejects names longer than the storage limit', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const filePath = path.join(projectPath, 'long-name.md');
        await writeFile(filePath, `---
name: ${'x'.repeat(81)}
schedule: "0 9 * * *"
model: openai/gpt-5
---
Run.
`, 'utf8');

        // Task names are clamped to 80 chars at storage time; a raw name that
        // exceeds it could never match the stored task, so the file is treated
        // as malformed rather than creating an unreachable definition.
        expect(parseLoopDefinition(filePath)).toBeNull();
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });
});

describe('discoverLoops', () => {
  it('discovers project loops and parses them', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      await writeLoop(projectPath, 'digest.md', `---
name: daily-digest
schedule: "0 9 * * *"
model: openai/gpt-5
---
Summarize.
`);

      const loops = discoverLoops(projectPath);

      expect(loops).toHaveLength(1);
      expect(loops[0].scope).toBe('project');
      expect(loops[0].definition.name).toBe('daily-digest');
      expect(loops[0].filePath.endsWith(path.join('.agents', 'loops', 'digest.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('scans ancestor directories up to the worktree root', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      // Worktree root contains the loop; the project directory is nested.
      const nested = path.join(projectPath, 'src', 'nested');
      await mkdir(nested, { recursive: true });
      await writeLoop(projectPath, 'root-loop.md', `---
name: root-loop
schedule: "0 9 * * *"
model: openai/gpt-5
---
From the root.
`);

      const loops = discoverLoops(nested);

      expect(loops.map((loop) => loop.definition.name)).toEqual(['root-loop']);
      expect(loops[0].scope).toBe('project');
    } finally {
      await cleanup();
    }
  });

  it('discovers user-scope loops from ~/.agents/loops', async () => {
    const { projectPath, cleanup } = await createProject();
    const home = await mkdtemp(path.join(os.tmpdir(), 'oc-loops-home-'));
    const userDir = path.join(home, '.agents', 'loops');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, 'user-loop.md'), `---
name: user-loop
schedule: "0 7 * * *"
model: openai/gpt-5
---
User scope.
`, 'utf8');
    const originalHome = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    try {
      const loops = discoverLoops(projectPath);

      expect(loops.map((loop) => loop.definition.name)).toEqual(['user-loop']);
      expect(loops[0].scope).toBe('user');
    } finally {
      os.homedir = originalHome;
      await rm(home, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('lets project scope shadow user scope on name collision', async () => {
    const { projectPath, cleanup } = await createProject();
    const home = await mkdtemp(path.join(os.tmpdir(), 'oc-loops-home-'));
    const userDir = path.join(home, '.agents', 'loops');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, 'same-name.md'), `---
name: shared
schedule: "0 7 * * *"
model: openai/gpt-5
---
User version.
`, 'utf8');
    await writeLoop(projectPath, 'same-name.md', `---
name: shared
schedule: "0 8 * * *"
model: anthropic/claude-sonnet-4-5
---
Project version.
`);
    const originalHome = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    try {
      const loops = discoverLoops(projectPath);

      expect(loops).toHaveLength(1);
      expect(loops[0].scope).toBe('project');
      expect(loops[0].definition.execution.providerID).toBe('anthropic');
      expect(loops[0].definition.schedule.cron).toBe('0 8 * * *');
    } finally {
      os.homedir = originalHome;
      await rm(home, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('reports malformed files as unparsed entries without blocking valid ones', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      await writeLoop(projectPath, 'bad.md', `---
name: bad
schedule: "0 9 * * *"
---
No model.
`);
      await writeLoop(projectPath, 'good.md', `---
name: good
schedule: "0 9 * * *"
model: openai/gpt-5
---
Valid.
`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const loops = discoverLoops(projectPath);

        // The malformed file stays visible as a `definition: null` entry so
        // the scheduler can keep its task alive while the file is fixed.
        const bad = loops.find((loop) => loop.filePath.endsWith(path.join('.agents', 'loops', 'bad.md')));
        expect(bad.definition).toBeNull();
        expect(bad.scope).toBe('project');

        const good = loops.find((loop) => loop.filePath.endsWith(path.join('.agents', 'loops', 'good.md')));
        expect(good.definition.name).toBe('good');
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  it('returns an empty list when nothing exists', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      expect(discoverLoops(projectPath)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('lists raw loop files per scope without parsing', async () => {
    const { projectPath, cleanup } = await createProject();
    try {
      await writeLoop(projectPath, 'one.md', `---
name: one
schedule: "0 9 * * *"
model: openai/gpt-5
---
One.
`);
      await writeFile(path.join(projectPath, 'not-a-loop.txt'), 'ignore me', 'utf8');

      const files = discoverLoopFiles(projectPath);

      expect(files).toHaveLength(1);
      expect(files[0].scope).toBe('project');
      expect(files[0].filePath.endsWith(path.join('.agents', 'loops', 'one.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
