import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SKILL_SUPPORTING_FILE_MAX_BYTES, walkSkillMdFiles, writeSkillSupportingFile } from './skill-files.js';

const FIXTURE_DIR = path.join(os.tmpdir(), `openchamber-skill-files-test-${process.pid}`);

// The walk states this value at its budget creation in skill-files.ts; the
// cap tests below exercise the walk at exactly this value.
const SKILL_WALK_MAX_DIRS = 5000;

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

  it('stops at the directory cap and returns the partial results found so far', async () => {
    // One leaf past the cap: the root plus SKILL_WALK_MAX_DIRS - 1 leaves
    // are visited, so exactly that many leaves report their SKILL.md.
    const leafCount = SKILL_WALK_MAX_DIRS + 10;
    for (let i = 0; i < leafCount; i += 1) {
      writeSkill(`d${String(i).padStart(4, '0')}`);
    }

    const found = await foundRelative();

    expect(found).toHaveLength(SKILL_WALK_MAX_DIRS - 1);
  });

  it('returns complete results for a tree exactly at the directory cap', async () => {
    const leafCount = SKILL_WALK_MAX_DIRS - 1;
    for (let i = 0; i < leafCount; i += 1) {
      writeSkill(`d${String(i).padStart(4, '0')}`);
    }

    expect(await foundRelative()).toHaveLength(leafCount);
  });

  it('allocates the directory cap deterministically across competing subtrees', async () => {
    // Two branches of 3,000 leaves each: the walk visits the root, branch a,
    // all of a's leaves, then branch b and only the leaves of b that fit the
    // remaining cap — depth-first readdir order, every time. Racing the two
    // subtrees for the cap would hand the last leaves to whichever branch's
    // readdir finished first.
    const leavesPerBranch = 3000;
    for (const branch of ['a', 'b']) {
      for (let i = 0; i < leavesPerBranch; i += 1) {
        writeSkill(path.join(branch, `d${String(i).padStart(4, '0')}`));
      }
    }

    const found = await foundRelative();

    const visitedUnderB = SKILL_WALK_MAX_DIRS - 3 - leavesPerBranch;
    expect(found).toHaveLength(leavesPerBranch + visitedUnderB);
    expect(found).toContain(path.join('a', 'd2999', 'SKILL.md'));
    expect(found).toContain(path.join('b', `d${String(visitedUnderB - 1).padStart(4, '0')}`, 'SKILL.md'));
    expect(found).not.toContain(path.join('b', 'd2999', 'SKILL.md'));
  }, 60_000);

  it('keeps a link to a large external tree under the same directory cap', async () => {
    const outside = `${FIXTURE_DIR}-outside`;
    fs.rmSync(outside, { recursive: true, force: true });
    const leafCount = SKILL_WALK_MAX_DIRS + 10;
    for (let i = 0; i < leafCount; i += 1) {
      const leaf = path.join(outside, `d${String(i).padStart(4, '0')}`);
      fs.mkdirSync(leaf, { recursive: true });
      fs.writeFileSync(path.join(leaf, 'SKILL.md'), STANDARD_MD);
    }
    fs.mkdirSync(path.join(FIXTURE_DIR, 'group'), { recursive: true });
    try {
      linkDirectory(outside, path.join('group', 'linked'));
      // Visited: the root, group, the linked external root, then leaves
      // until the cap; every visited leaf reports one SKILL.md.
      expect(await foundRelative()).toHaveLength(SKILL_WALK_MAX_DIRS - 3);
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

describe('writeSkillSupportingFile', () => {
  const WRITE_DIR = path.join(os.tmpdir(), `openchamber-skill-write-test-${process.pid}`);

  beforeEach(() => {
    fs.rmSync(WRITE_DIR, { recursive: true, force: true });
    fs.mkdirSync(WRITE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(WRITE_DIR, { recursive: true, force: true });
  });

  it('writes string content', () => {
    const skillDir = path.join(WRITE_DIR, 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    writeSkillSupportingFile(skillDir, 'notes.md', 'hello');
    expect(fs.readFileSync(path.join(skillDir, 'notes.md'), 'utf8')).toBe('hello');
  });

  it('writes byte-view content byte-exact, including non-UTF8 bytes', () => {
    const skillDir = path.join(WRITE_DIR, 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x41, 0x80]);
    writeSkillSupportingFile(skillDir, 'data.bin', bytes);
    expect([...fs.readFileSync(path.join(skillDir, 'data.bin'))]).toEqual([...bytes]);
  });

  it('refuses over-cap content before writing anything', () => {
    const skillDir = path.join(WRITE_DIR, 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const big = 'x'.repeat(SKILL_SUPPORTING_FILE_MAX_BYTES + 1);
    expect(() => writeSkillSupportingFile(skillDir, 'big.txt', big)).toThrow(/too large/);
    expect(fs.existsSync(path.join(skillDir, 'big.txt'))).toBe(false);
  });
});
