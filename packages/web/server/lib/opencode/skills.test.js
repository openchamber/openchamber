import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { getSkillSources, mergeDiscoveredSkills, updateSkill } from './skills.js';

const SOURCE_SKILL_NAME = 'rename-source';
const RENAMED_SKILL_NAME = 'rename-target';
const SKILL_INSTRUCTIONS = '# Workflow\n\nKeep every instruction intact.';
const ORIGINAL_SKILL_CONTENT = [
  '---',
  '# Preserve this comment and formatting.',
  `name: "${SOURCE_SKILL_NAME}" # Keep the quotes and inline comment.`,
  'description: Preserve this description',
  'metadata: [one, two]',
  '---',
  '',
  SKILL_INSTRUCTIONS,
  '',
].join('\n');
const RENAMED_SKILL_CONTENT = ORIGINAL_SKILL_CONTENT.replace(
  `"${SOURCE_SKILL_NAME}"`,
  `"${RENAMED_SKILL_NAME}"`,
);
const SUPPORTING_CONTENT = 'Supporting content';

async function createRenameFixture() {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-rename-'));
  const sourceDir = path.join(tempRoot, '.opencode', 'skills', SOURCE_SKILL_NAME);
  const renamedDir = path.join(tempRoot, '.opencode', 'skills', RENAMED_SKILL_NAME);
  const skillPath = path.join(sourceDir, 'SKILL.md');
  const supportingPath = path.join(sourceDir, 'references', 'guide.md');

  await fsPromises.mkdir(path.dirname(supportingPath), { recursive: true });
  await fsPromises.writeFile(skillPath, ORIGINAL_SKILL_CONTENT, 'utf8');
  await fsPromises.writeFile(supportingPath, SUPPORTING_CONTENT, 'utf8');

  return { tempRoot, sourceDir, renamedDir, skillPath, supportingPath };
}

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

  it('renames a skill without losing its content or supporting files', async () => {
    const fixture = await createRenameFixture();

    try {
      updateSkill(
        SOURCE_SKILL_NAME,
        { name: RENAMED_SKILL_NAME, targetPath: fixture.skillPath },
        fixture.tempRoot,
        fixture.skillPath,
      );

      await expect(fsPromises.stat(fixture.sourceDir)).rejects.toMatchObject({ code: 'ENOENT' });
      const renamedSkillPath = path.join(fixture.renamedDir, 'SKILL.md');
      const sources = getSkillSources(RENAMED_SKILL_NAME, fixture.tempRoot);
      expect(sources.md.path).toBe(renamedSkillPath);
      expect(sources.md.description).toBe('Preserve this description');
      expect(sources.md.instructions).toBe(SKILL_INSTRUCTIONS);
      await expect(fsPromises.readFile(renamedSkillPath, 'utf8')).resolves.toBe(RENAMED_SKILL_CONTENT);
      await expect(fsPromises.readFile(
        path.join(fixture.renamedDir, 'references', 'guide.md'),
        'utf8',
      )).resolves.toBe(SUPPORTING_CONTENT);
    } finally {
      await fsPromises.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a selected path that is not the canonical skill path', async () => {
    const fixture = await createRenameFixture();
    const selectedPath = path.join(fixture.tempRoot, 'selected', SOURCE_SKILL_NAME, 'SKILL.md');

    try {
      await fsPromises.mkdir(path.dirname(selectedPath), { recursive: true });
      await fsPromises.writeFile(selectedPath, ORIGINAL_SKILL_CONTENT, 'utf8');

      expect(() => updateSkill(
        SOURCE_SKILL_NAME,
        { name: RENAMED_SKILL_NAME, targetPath: selectedPath },
        fixture.tempRoot,
        fixture.skillPath,
      )).toThrow(`target does not match ${path.resolve(selectedPath)}`);

      await expect(fsPromises.readFile(fixture.skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fsPromises.readFile(selectedPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fsPromises.stat(fixture.renamedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsPromises.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('restores the original content when moving the skill directory fails', async () => {
    const fixture = await createRenameFixture();
    const renameError = new Error('forced rename failure');
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });

    try {
      expect(() => updateSkill(
        SOURCE_SKILL_NAME,
        { name: RENAMED_SKILL_NAME, targetPath: fixture.skillPath },
        fixture.tempRoot,
        fixture.skillPath,
      )).toThrow(renameError);

      expect(renameSpy).toHaveBeenCalledOnce();
      await expect(fsPromises.readFile(fixture.skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fsPromises.readFile(fixture.supportingPath, 'utf8')).resolves.toBe(SUPPORTING_CONTENT);
      await expect(fsPromises.stat(fixture.renamedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      renameSpy.mockRestore();
      await fsPromises.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects renaming a skill whose file is not in a dedicated directory', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-root-'));
    const skillsDir = path.join(tempRoot, '.opencode', 'skills');
    const skillPath = path.join(skillsDir, 'SKILL.md');
    const siblingPath = path.join(skillsDir, 'keep.txt');

    try {
      await fsPromises.mkdir(skillsDir, { recursive: true });
      await fsPromises.writeFile(skillPath, ORIGINAL_SKILL_CONTENT, 'utf8');
      await fsPromises.writeFile(siblingPath, SUPPORTING_CONTENT, 'utf8');

      expect(() => updateSkill(
        SOURCE_SKILL_NAME,
        { name: RENAMED_SKILL_NAME, targetPath: skillPath },
        tempRoot,
        skillPath,
      )).toThrow('must be stored in its own directory');

      await expect(fsPromises.readFile(skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fsPromises.readFile(siblingPath, 'utf8')).resolves.toBe(SUPPORTING_CONTENT);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid, combined, and colliding rename requests', async () => {
    const fixture = await createRenameFixture();
    const targetPath = path.join(fixture.renamedDir, 'SKILL.md');

    try {
      expect(() => updateSkill(
        SOURCE_SKILL_NAME,
        { name: 'Invalid Name', targetPath: fixture.skillPath },
        fixture.tempRoot,
        fixture.skillPath,
      )).toThrow('Invalid skill name');
      expect(() => updateSkill(
        SOURCE_SKILL_NAME,
        { name: RENAMED_SKILL_NAME, description: 'Changed', targetPath: fixture.skillPath },
        fixture.tempRoot,
        fixture.skillPath,
      )).toThrow('cannot be combined with other updates');

      await fsPromises.mkdir(fixture.renamedDir, { recursive: true });
      await fsPromises.writeFile(targetPath, RENAMED_SKILL_CONTENT, 'utf8');
      expect(() => updateSkill(
        SOURCE_SKILL_NAME,
        { name: RENAMED_SKILL_NAME, targetPath: fixture.skillPath },
        fixture.tempRoot,
        fixture.skillPath,
      )).toThrow('already exists');
      await expect(fsPromises.readFile(fixture.skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
    } finally {
      await fsPromises.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
