import { describe, expect, it } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { discoverSkills, getSkillSources, mergeDiscoveredSkills, renameSkill } from './skills.js';

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

  it('discovers repository-local .agents skills for the project directory', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-project-agents-'));
    const skillDir = path.join(tempRoot, '.agents', 'skills', 'repo-local-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.mkdir(path.join(tempRoot, '.git'));
      await fsPromises.writeFile(
        skillPath,
        [
          '---',
          'name: repo-local-skill',
          'description: Repository-local agents skill',
          '---',
          '',
          'Use this skill in this repository.',
          '',
        ].join('\n'),
        'utf8',
      );

      const discovered = discoverSkills(tempRoot);
      const match = discovered.find((skill) => skill.name === 'repo-local-skill');

      expect(match).toEqual({
        name: 'repo-local-skill',
        path: skillPath,
        scope: 'project',
        source: 'agents',
        description: 'Repository-local agents skill',
      });
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
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

  it('renames a skill directory while preserving SKILL.md body and supporting files', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-rename-'));
    const projectRoot = path.join(tempRoot, 'project');
    const skillDir = path.join(projectRoot, '.opencode', 'skills', 'original-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const supportPath = path.join(skillDir, 'notes.md');
    const body = [
      '# Original Skill',
      '',
      'Preserve this non-trivial body across rename.',
      '',
      '## Details',
      '',
      '- step one',
      '- step two',
    ].join('\n');

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(
        skillPath,
        [
          '---',
          'name: original-skill',
          'description: Original skill description',
          'license: MIT',
          '---',
          '',
          body,
          '',
        ].join('\n'),
        'utf8',
      );
      await fsPromises.writeFile(supportPath, 'supporting file contents\n', 'utf8');

      renameSkill('original-skill', 'renamed-skill', projectRoot);

      const renamedDir = path.join(projectRoot, '.opencode', 'skills', 'renamed-skill');
      const renamedPath = path.join(renamedDir, 'SKILL.md');
      const renamedSupportPath = path.join(renamedDir, 'notes.md');

      expect(fs.existsSync(skillDir)).toBe(false);
      expect(fs.existsSync(renamedPath)).toBe(true);
      expect(fs.existsSync(renamedSupportPath)).toBe(true);

      const sources = getSkillSources('renamed-skill', projectRoot, {
        name: 'renamed-skill',
        path: renamedPath,
        scope: 'project',
        source: 'opencode',
        description: 'fallback',
      });

      expect(sources.md.exists).toBe(true);
      expect(sources.md.name).toBe('renamed-skill');
      expect(sources.md.description).toBe('Original skill description');
      expect(sources.md.instructions).toBe(body);
      expect(await fsPromises.readFile(renamedSupportPath, 'utf8')).toBe('supporting file contents\n');

      const raw = await fsPromises.readFile(renamedPath, 'utf8');
      expect(raw).toContain('license: MIT');
      expect(raw).not.toContain('Renamed skill');
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rolls back the directory rename when frontmatter write fails', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-rename-rollback-'));
    const projectRoot = path.join(tempRoot, 'project');
    const skillDir = path.join(projectRoot, '.opencode', 'skills', 'rollback-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const body = '# Rollback body\n\nMust remain in the original directory.';

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(
        skillPath,
        [
          '---',
          'name: rollback-skill',
          'description: Rollback skill',
          '---',
          '',
          body,
          '',
        ].join('\n'),
        'utf8',
      );
      await fsPromises.chmod(skillPath, 0o444);

      expect(() => renameSkill('rollback-skill', 'rollback-skill-renamed', projectRoot)).toThrow();

      expect(fs.existsSync(skillDir)).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.opencode', 'skills', 'rollback-skill-renamed'))).toBe(false);
      expect(await fsPromises.readFile(skillPath, 'utf8')).toContain(body);
    } finally {
      try {
        await fsPromises.chmod(skillPath, 0o644);
      } catch {
        // Best-effort cleanup when the file was rolled back under a different mode.
      }
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid names, missing skills, conflicts, unmanaged paths, and frontmatter mismatches', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-rename-reject-'));
    const projectRoot = path.join(tempRoot, 'project');
    const managedDir = path.join(projectRoot, '.opencode', 'skills', 'managed-skill');
    const conflictDir = path.join(projectRoot, '.opencode', 'skills', 'taken-name');
    const mismatchDir = path.join(projectRoot, '.opencode', 'skills', 'folder-name');
    const cacheStamp = `oc-rename-${Date.now()}`;
    const cacheDir = path.join(os.homedir(), '.cache', 'opencode', 'skills', cacheStamp, 'cache-skill');

    try {
      await fsPromises.mkdir(managedDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(managedDir, 'SKILL.md'),
        [
          '---',
          'name: managed-skill',
          'description: Managed',
          '---',
          '',
          'Managed body',
          '',
        ].join('\n'),
        'utf8',
      );

      await fsPromises.mkdir(conflictDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(conflictDir, 'SKILL.md'),
        [
          '---',
          'name: taken-name',
          'description: Taken',
          '---',
          '',
          'Taken body',
          '',
        ].join('\n'),
        'utf8',
      );

      await fsPromises.mkdir(mismatchDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(mismatchDir, 'SKILL.md'),
        [
          '---',
          'name: frontmatter-name',
          'description: Mismatch',
          '---',
          '',
          'Mismatch body',
          '',
        ].join('\n'),
        'utf8',
      );

      await fsPromises.mkdir(cacheDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(cacheDir, 'SKILL.md'),
        [
          '---',
          'name: cache-skill',
          'description: Cache skill',
          '---',
          '',
          'Cache body',
          '',
        ].join('\n'),
        'utf8',
      );

      expect(() => renameSkill('managed-skill', 'Invalid_Name', projectRoot)).toThrow(/Invalid skill name/);
      expect(() => renameSkill('missing-skill', 'new-skill', projectRoot)).toThrow(/not found/);
      expect(() => renameSkill('managed-skill', 'taken-name', projectRoot)).toThrow(/already exists/);
      expect(() => renameSkill('folder-name', 'renamed-mismatch', projectRoot)).toThrow(/does not match/);
      expect(() => renameSkill('cache-skill', 'cache-skill-renamed', projectRoot)).toThrow(/managed skill directories/);

      expect(fs.existsSync(managedDir)).toBe(true);
      expect(fs.existsSync(cacheDir)).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.opencode', 'skills', 'renamed-mismatch'))).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
      await fsPromises.rm(path.join(os.homedir(), '.cache', 'opencode', 'skills', cacheStamp), {
        recursive: true,
        force: true,
      });
    }
  });
});
