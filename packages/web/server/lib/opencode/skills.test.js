import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { registerSkillRenameContract } from '../../../../../scripts/skill-rename-test-contract.js';
import { registerSkillRoutes } from './skill-routes.js';
import { discoverSkills, getSkillSources, isInvalidSkillName, mergeDiscoveredSkills, updateSkill } from './skills.js';

describe('skills', () => {
  it('merges locally discovered skills missing from OpenCode live discovery', () => {
    const merged = mergeDiscoveredSkills(
      [
        { name: 'existing-opencode-skill', path: '/home/jkker/.config/opencode/skills/existing-opencode-skill/SKILL.md', source: 'opencode' },
        { name: 'existing-agent-skill', path: '/home/jkker/.agents/skills/existing-agent-skill/SKILL.md', source: 'agents' },
      ],
      [
        { name: 'existing-agent-skill', path: '/home/jkker/.agents/skills/existing-agent-skill/SKILL.md', source: 'agents' },
        { name: 'new-agent-skill', path: '/home/jkker/.agents/skills/new-agent-skill/SKILL.md', source: 'agents' },
      ],
    );

    expect(merged.map((skill) => skill.name)).toEqual([
      'existing-opencode-skill',
      'existing-agent-skill',
      'new-agent-skill',
    ]);
  });

  it('resolves built-in OpenCode skill content without parsing virtual locations as files', () => {
    const sources = getSkillSources(
      'customize-opencode',
      '/tmp/openchamber-skills-test-missing-project',
      {
        name: 'customize-opencode',
        path: '<built-in>',
        scope: 'user',
        source: 'opencode',
        description: 'Customize opencode',
        content: '# Customizing opencode\n\nUse this skill when updating config.',
      },
    );

    expect(sources.md.exists).toBe(true);
    expect(sources.md.path).toBe(null);
    expect(sources.md.dir).toBe(null);
    expect(sources.md.scope).toBe('user');
    expect(sources.md.source).toBe('opencode');
    expect(sources.md.description).toBe('Customize opencode');
    expect(sources.md.instructions).toBe('# Customizing opencode\n\nUse this skill when updating config.');
    expect(sources.md.fields).toEqual(['description', 'instructions']);
  });

  it('clears file metadata when a discovered skill path is unreadable', () => {
    const missingPath = path.join(os.tmpdir(), 'openchamber-skills-test-missing-file', 'SKILL.md');
    const sources = getSkillSources(
      'missing-agent-skill',
      '/tmp/openchamber-skills-test-missing-project',
      {
        name: 'missing-agent-skill',
        path: missingPath,
        scope: 'user',
        source: 'agents',
        description: 'Missing skill',
      },
    );

    expect(sources.md.exists).toBe(false);
    expect(sources.md.path).toBe(null);
    expect(sources.md.dir).toBe(null);
    expect(sources.md.scope).toBe(null);
    expect(sources.md.source).toBe(null);
    expect(sources.md.description).toBe('Missing skill');
    expect(sources.md.instructions).toBe('');
  });

  it('enriches discovered skills when their location is a real markdown file', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-'));
    const skillDir = path.join(tempRoot, 'example-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(
        skillPath,
        [
          '---',
          'name: example-skill',
          'description: Example from agents',
          '---',
          '',
          'Use this skill for examples.',
          '',
        ].join('\n'),
        'utf8',
      );

      const sources = getSkillSources('example-skill', tempRoot, {
        name: 'example-skill',
        path: skillPath,
        scope: 'user',
        source: 'agents',
        description: 'Fallback description',
      });

      expect(sources.md.exists).toBe(true);
      expect(sources.md.path).toBe(skillPath);
      expect(sources.md.scope).toBe('user');
      expect(sources.md.source).toBe('agents');
      expect(sources.md.description).toBe('Example from agents');
      expect(sources.md.instructions).toBe('Use this skill for examples.');
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('validates rename names before requiring authoritative discovery', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skill-route-'));
    const skillDir = path.join(tempRoot, '.opencode', 'skills', 'rename-source');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const app = express();
    app.use(express.json());
    registerSkillRoutes(app, {
      fs,
      path,
      os,
      resolveOptionalProjectDirectory: async () => ({ directory: tempRoot, error: null }),
      refreshOpenCodeAfterConfigChange: vi.fn(),
      clientReloadDelayMs: 1,
      buildOpenCodeUrl: () => 'http://127.0.0.1/',
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodePort: () => null,
      isInvalidSkillName,
      getSkillSources,
      discoverSkills,
      mergeDiscoveredSkills,
      updateSkill,
      SKILL_SCOPE: { PROJECT: 'project', USER: 'user' },
    });

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(skillPath, '---\nname: rename-source\ndescription: Test\n---\n', 'utf8');

      const invalid = await request(app)
        .patch('/api/config/skills/rename-source')
        .send({ name: 'Invalid Name', targetPath: skillPath })
        .expect(500);
      expect(invalid.body.error).toContain('Invalid skill name');

      const unavailable = await request(app)
        .patch('/api/config/skills/rename-source')
        .send({ name: 'rename-target', targetPath: skillPath })
        .expect(500);
      expect(unavailable.body.error).toContain('skill discovery is unavailable');
      expect(await fsPromises.readFile(skillPath, 'utf8')).toContain('name: rename-source');
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  registerSkillRenameContract({
    afterEach,
    expect,
    spyOn: vi.spyOn,
    test: it,
    updateSkill,
    tempPrefix: 'oc-web-skills-rename-',
  });
});
