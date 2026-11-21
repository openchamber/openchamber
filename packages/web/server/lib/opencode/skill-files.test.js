import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { walkSkillMdFiles } from './skill-files.js';

const FIXTURE_DIR = path.join(os.tmpdir(), `openchamber-skill-files-test-${process.pid}`);

const STANDARD_MD = [
  '---',
  'description: My build agent',
  'model: anthropic/claude-sonnet-4',
  'mode: primary',
  '---',
  '',
  'This is the prompt body.',
  '',
].join('\n');

const writeFixture = (name, content) => {
  const filePath = path.join(FIXTURE_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};
describe('walkSkillMdFiles', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  const writeSkill = (relativeDir) => writeFixture(path.join(relativeDir, 'SKILL.md'), STANDARD_MD);
  // A junction needs no elevation on Windows, which is what Skills Manager deploys;
  // the type argument is ignored on POSIX.
  const linkDirectory = (target, relativeLink) =>
    fs.symlinkSync(target, path.join(FIXTURE_DIR, relativeLink), process.platform === 'win32' ? 'junction' : 'dir');
  const foundRelative = async () =>
    (await walkSkillMdFiles(FIXTURE_DIR))
      .map((found) => path.relative(FIXTURE_DIR, found).split(path.sep).join('/'))
      .sort();

  it('walks a skill deployed as a link inside the scanned root', async () => {
    writeSkill('real-skill');
    fs.mkdirSync(path.join(FIXTURE_DIR, 'collection'), { recursive: true });
    writeSkill(path.join('collection', 'nested-skill'));
    linkDirectory(path.join(FIXTURE_DIR, 'real-skill'), 'linked-skill');
    linkDirectory(path.join(FIXTURE_DIR, 'collection'), 'collection-link');

    expect(await foundRelative()).toEqual([
      'collection-link/nested-skill/SKILL.md',
      'collection/nested-skill/SKILL.md',
      'linked-skill/SKILL.md',
      'real-skill/SKILL.md',
    ]);
  });

  it('ends on a link that points back into the scanned tree', async () => {
    fs.mkdirSync(path.join(FIXTURE_DIR, 'loopdir'), { recursive: true });
    writeSkill('loopdir');
    linkDirectory(FIXTURE_DIR, path.join('loopdir', 'back'));

    expect(await foundRelative()).toEqual(['loopdir/SKILL.md']);
  });

  it('skips a link whose target is gone and keeps the rest of the scan', async () => {
    writeSkill('real-skill');
    fs.mkdirSync(path.join(FIXTURE_DIR, 'gone-skill'), { recursive: true });
    linkDirectory(path.join(FIXTURE_DIR, 'gone-skill'), 'dangling-link');
    fs.rmSync(path.join(FIXTURE_DIR, 'gone-skill'), { recursive: true, force: true });

    expect(await foundRelative()).toEqual(['real-skill/SKILL.md']);
  });

  it('follows a link nested below the top level of the scanned root', async () => {
    const outside = `${FIXTURE_DIR}-outside`;
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(path.join(outside, 'deep-skill'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'deep-skill', 'SKILL.md'), STANDARD_MD);
    fs.mkdirSync(path.join(FIXTURE_DIR, 'group'), { recursive: true });
    try {
      linkDirectory(path.join(outside, 'deep-skill'), path.join('group', 'linked'));
      expect(await foundRelative()).toEqual(['group/linked/SKILL.md']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ends on a nested link loop between two directories', async () => {
    fs.mkdirSync(path.join(FIXTURE_DIR, 'a'), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'b'), { recursive: true });
    writeSkill('a');
    linkDirectory(path.join(FIXTURE_DIR, 'b'), path.join('a', 'to-b'));
    linkDirectory(path.join(FIXTURE_DIR, 'a'), path.join('b', 'to-a'));

    expect(await foundRelative()).toEqual(['a/SKILL.md', 'b/to-a/SKILL.md']);
  });
});
