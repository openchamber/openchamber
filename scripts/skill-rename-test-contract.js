import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_NAME = 'rename-source';
const TARGET_NAME = 'rename-target';
const ORIGINAL_CONTENT = `---
# Preserve this comment and formatting.
name: "${SOURCE_NAME}" # Keep the quotes and inline comment.
description: Preserve this description
metadata: [one, two]
---

# Workflow

Keep every instruction intact.
`;
const RENAMED_CONTENT = ORIGINAL_CONTENT.replace(SOURCE_NAME, TARGET_NAME);
const SUPPORTING_CONTENT = 'Supporting content';

export function registerSkillRenameContract({ afterEach, expect, spyOn, test, updateSkill, tempPrefix }) {
  const tempRoots = [];
  const spies = [];
  const createFixture = (dedicatedDirectory = true) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
    const skillsDir = path.join(tempRoot, '.opencode', 'skills');
    const sourceDir = dedicatedDirectory ? path.join(skillsDir, SOURCE_NAME) : skillsDir;
    const renamedDir = path.join(skillsDir, TARGET_NAME);
    const skillPath = path.join(sourceDir, 'SKILL.md');
    const supportingPath = path.join(sourceDir, dedicatedDirectory ? 'references/guide.md' : 'keep.txt');

    tempRoots.push(tempRoot);
    fs.mkdirSync(path.dirname(supportingPath), { recursive: true });
    fs.writeFileSync(skillPath, ORIGINAL_CONTENT, 'utf8');
    fs.writeFileSync(supportingPath, SUPPORTING_CONTENT, 'utf8');
    return { tempRoot, sourceDir, renamedDir, skillPath, supportingPath };
  };
  const renameSkill = (fixture, updates = {}, discoveredSkillNames = []) => updateSkill(
    SOURCE_NAME,
    { name: TARGET_NAME, targetPath: fixture.skillPath, ...updates },
    fixture.tempRoot,
    fixture.skillPath,
    discoveredSkillNames,
  );

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const tempRoot of tempRoots.splice(0)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('renames a skill without rewriting its content or supporting files', () => {
    const fixture = createFixture();
    renameSkill(fixture);

    expect(fs.existsSync(fixture.sourceDir)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.renamedDir, 'SKILL.md'), 'utf8')).toBe(RENAMED_CONTENT);
    expect(fs.readFileSync(path.join(fixture.renamedDir, 'references', 'guide.md'), 'utf8')).toBe(SUPPORTING_CONTENT);
  });

  test('rejects a selected path that is not the canonical skill path', () => {
    const fixture = createFixture();
    const selectedPath = path.join(fixture.tempRoot, 'selected', SOURCE_NAME, 'SKILL.md');
    fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
    fs.writeFileSync(selectedPath, ORIGINAL_CONTENT, 'utf8');

    expect(() => renameSkill(fixture, { targetPath: selectedPath })).toThrow(`target does not match ${path.resolve(selectedPath)}`);
    expect(fs.readFileSync(fixture.skillPath, 'utf8')).toBe(ORIGINAL_CONTENT);
    expect(fs.readFileSync(selectedPath, 'utf8')).toBe(ORIGINAL_CONTENT);
  });

  test('restores the original content when moving the skill directory fails', () => {
    const fixture = createFixture();
    const renameError = new Error('forced rename failure');
    const renameSpy = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });
    spies.push(renameSpy);

    expect(() => renameSkill(fixture)).toThrow(renameError);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(fixture.skillPath, 'utf8')).toBe(ORIGINAL_CONTENT);
  });

  test('rejects renaming shared or nested skill directories', () => {
    const fixture = createFixture(false);
    expect(() => renameSkill(fixture)).toThrow('must be stored in its own directory');
    expect(fs.readFileSync(fixture.supportingPath, 'utf8')).toBe(SUPPORTING_CONTENT);

    const nestedFixture = createFixture();
    const nestedSkillPath = path.join(nestedFixture.sourceDir, 'nested', 'SKILL.md');
    fs.mkdirSync(path.dirname(nestedSkillPath), { recursive: true });
    fs.writeFileSync(nestedSkillPath, ORIGINAL_CONTENT, 'utf8');
    expect(() => renameSkill(nestedFixture)).toThrow('contains nested skills');
  });

  test('rejects invalid, combined, and colliding rename requests', () => {
    const fixture = createFixture();
    expect(() => renameSkill(fixture, { name: 'Invalid Name' })).toThrow('Invalid skill name');
    expect(() => renameSkill(fixture, { description: 'Changed' })).toThrow('cannot be combined with other updates');
    expect(() => renameSkill(fixture, {}, [TARGET_NAME])).toThrow('already exists');

    fs.mkdirSync(fixture.renamedDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.renamedDir, 'SKILL.md'), RENAMED_CONTENT, 'utf8');
    expect(() => renameSkill(fixture)).toThrow('already exists');
    expect(fs.readFileSync(fixture.skillPath, 'utf8')).toBe(ORIGINAL_CONTENT);
  });
}
