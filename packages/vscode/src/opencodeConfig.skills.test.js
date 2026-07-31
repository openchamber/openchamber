import { describe, expect, spyOn, test } from 'bun:test';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BUILT_IN_SKILL_LOCATION,
  getSkillSources,
  mergeDiscoveredSkills,
  updateSkill,
} from './opencodeConfig';

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

const createRenameFixture = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-skills-rename-'));
  const sourceDir = path.join(tempRoot, '.opencode', 'skills', SOURCE_SKILL_NAME);
  const renamedDir = path.join(tempRoot, '.opencode', 'skills', RENAMED_SKILL_NAME);
  const skillPath = path.join(sourceDir, 'SKILL.md');
  const supportingPath = path.join(sourceDir, 'references', 'guide.md');

  await fs.mkdir(path.dirname(supportingPath), { recursive: true });
  await fs.writeFile(skillPath, ORIGINAL_SKILL_CONTENT, 'utf8');
  await fs.writeFile(supportingPath, SUPPORTING_CONTENT, 'utf8');

  return { tempRoot, sourceDir, renamedDir, skillPath, supportingPath };
};

describe('VS Code skill discovery parity', () => {
  test('merges OpenCode API skills with locally discovered fallback skills', () => {
    const merged = mergeDiscoveredSkills(
      [
        { name: 'built-in', path: BUILT_IN_SKILL_LOCATION, scope: 'user', source: 'opencode' },
        { name: 'local-first', path: '/tmp/local-first/SKILL.md', scope: 'user', source: 'agents' },
      ],
      [
        { name: 'local-first', path: '/tmp/local-first/SKILL.md', scope: 'user', source: 'agents' },
        { name: 'local-only', path: '/tmp/local-only/SKILL.md', scope: 'project', source: 'claude' },
      ],
    );

    expect(merged.map((skill) => skill.name)).toEqual(['built-in', 'local-first', 'local-only']);
  });

  test('resolves built-in skills without treating the virtual location as a file', () => {
    const discoveredSkill = {
      name: 'customize-opencode',
      path: BUILT_IN_SKILL_LOCATION,
      scope: 'user',
      source: 'opencode',
      description: 'Customize opencode',
      content: '# Customize opencode\n\nUse for config work.',
    };

    const sources = getSkillSources('customize-opencode', '/tmp/openchamber-vscode-skills-test', discoveredSkill);

    expect(sources.md.exists).toBe(true);
    expect(sources.md.path).toBeNull();
    expect(sources.md.dir).toBeNull();
    expect(sources.md.scope).toBe('user');
    expect(sources.md.source).toBe('opencode');
    expect(sources.md.description).toBe('Customize opencode');
    expect(sources.md.instructions).toBe('# Customize opencode\n\nUse for config work.');
    expect(sources.md.fields).toEqual(['description', 'instructions']);
  });

  test('renames a skill without rewriting its content or supporting files', async () => {
    const fixture = await createRenameFixture();

    try {
      updateSkill(SOURCE_SKILL_NAME, {
        name: RENAMED_SKILL_NAME,
        targetPath: fixture.skillPath,
      }, fixture.tempRoot, fixture.skillPath);

      await expect(fs.stat(fixture.sourceDir)).rejects.toMatchObject({ code: 'ENOENT' });
      const renamedSkillPath = path.join(fixture.renamedDir, 'SKILL.md');
      const sources = getSkillSources(RENAMED_SKILL_NAME, fixture.tempRoot);
      expect(sources.md.path).toBe(renamedSkillPath);
      expect(sources.md.description).toBe('Preserve this description');
      expect(sources.md.instructions).toBe(SKILL_INSTRUCTIONS);
      await expect(fs.readFile(renamedSkillPath, 'utf8')).resolves.toBe(RENAMED_SKILL_CONTENT);
      await expect(fs.readFile(
        path.join(fixture.renamedDir, 'references', 'guide.md'),
        'utf8',
      )).resolves.toBe(SUPPORTING_CONTENT);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a selected path that is not the canonical skill path', async () => {
    const fixture = await createRenameFixture();
    const selectedPath = path.join(fixture.tempRoot, 'selected', SOURCE_SKILL_NAME, 'SKILL.md');

    try {
      await fs.mkdir(path.dirname(selectedPath), { recursive: true });
      await fs.writeFile(selectedPath, ORIGINAL_SKILL_CONTENT, 'utf8');

      expect(() => updateSkill(SOURCE_SKILL_NAME, {
        name: RENAMED_SKILL_NAME,
        targetPath: selectedPath,
      }, fixture.tempRoot, fixture.skillPath)).toThrow(`target does not match ${path.resolve(selectedPath)}`);

      await expect(fs.readFile(fixture.skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fs.readFile(selectedPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fs.stat(fixture.renamedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('restores the original content when moving the skill directory fails', async () => {
    const fixture = await createRenameFixture();
    const renameError = new Error('forced rename failure');
    const renameSpy = spyOn(fsSync, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });

    try {
      expect(() => updateSkill(SOURCE_SKILL_NAME, {
        name: RENAMED_SKILL_NAME,
        targetPath: fixture.skillPath,
      }, fixture.tempRoot, fixture.skillPath)).toThrow(renameError);

      expect(renameSpy).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(fixture.skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fs.readFile(fixture.supportingPath, 'utf8')).resolves.toBe(SUPPORTING_CONTENT);
      await expect(fs.stat(fixture.renamedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      renameSpy.mockRestore();
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects renaming a skill whose file is not in a dedicated directory', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-skills-root-'));
    const skillsDir = path.join(tempRoot, '.opencode', 'skills');
    const skillPath = path.join(skillsDir, 'SKILL.md');
    const siblingPath = path.join(skillsDir, 'keep.txt');

    try {
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.writeFile(skillPath, ORIGINAL_SKILL_CONTENT, 'utf8');
      await fs.writeFile(siblingPath, SUPPORTING_CONTENT, 'utf8');

      expect(() => updateSkill(SOURCE_SKILL_NAME, {
        name: RENAMED_SKILL_NAME,
        targetPath: skillPath,
      }, tempRoot, skillPath)).toThrow('must be stored in its own directory');

      await expect(fs.readFile(skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
      await expect(fs.readFile(siblingPath, 'utf8')).resolves.toBe(SUPPORTING_CONTENT);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects invalid, combined, and colliding rename requests', async () => {
    const fixture = await createRenameFixture();
    const targetPath = path.join(fixture.renamedDir, 'SKILL.md');

    try {
      expect(() => updateSkill(SOURCE_SKILL_NAME, {
        name: 'Invalid Name',
        targetPath: fixture.skillPath,
      }, fixture.tempRoot, fixture.skillPath)).toThrow('Invalid skill name');
      expect(() => updateSkill(SOURCE_SKILL_NAME, {
        name: RENAMED_SKILL_NAME,
        description: 'Changed',
        targetPath: fixture.skillPath,
      }, fixture.tempRoot, fixture.skillPath)).toThrow('cannot be combined with other updates');

      await fs.mkdir(fixture.renamedDir, { recursive: true });
      await fs.writeFile(targetPath, RENAMED_SKILL_CONTENT, 'utf8');
      expect(() => updateSkill(SOURCE_SKILL_NAME, {
        name: RENAMED_SKILL_NAME,
        targetPath: fixture.skillPath,
      }, fixture.tempRoot, fixture.skillPath)).toThrow('already exists');
      await expect(fs.readFile(fixture.skillPath, 'utf8')).resolves.toBe(ORIGINAL_SKILL_CONTENT);
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
