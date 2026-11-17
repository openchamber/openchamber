import './opencodeConfigTestHome';
import { describe, expect, test } from 'bun:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUILT_IN_SKILL_LOCATION,
  deleteSkillSupportingFile,
  discoverSkills,
  getSkillSources,
  listSnippets,
  MD_FILE_MAX_BYTES,
  mergeDiscoveredSkills,
  parseMdFile,
  readSkillSupportingFile,
  updateSkill,
  writeSkillSupportingFile,
} from './opencodeConfig';

// The skill walks state this value at their budget creation in
// opencodeConfig.ts (design #1391); the cap tests below exercise the
// walks at exactly this value.
const SKILL_WALK_MAX_DIRS = 5000;

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
});
describe('VS Code skill walk directory cap (#1357)', () => {
  const withTempDir = (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-walk-'));
    try {
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const writeLeafSkills = (skillsRoot, leafCount) => {
    for (let i = 0; i < leafCount; i += 1) {
      const leaf = path.join(skillsRoot, `d${String(i).padStart(4, '0')}`);
      fs.mkdirSync(leaf, { recursive: true });
      fs.writeFileSync(
        path.join(leaf, 'SKILL.md'),
        `---\nname: cap-skill-${i}\n---\n\nbody\n`,
        'utf8',
      );
    }
  };

  test('states the same walk budget as the web twin in shared.js', () => {
    const webSource = fs.readFileSync(
      new URL('../../web/server/lib/opencode/shared.js', import.meta.url),
      'utf8',
    );
    expect(webSource).toContain('createTraversalBudget({ maxDirs: 5000 })');
    const ownSource = fs.readFileSync(new URL('./opencodeConfig.ts', import.meta.url), 'utf8');
    expect(ownSource).toContain('createTraversalBudget({ maxDirs: 5000 })');
  });

  test('discovery stops at the directory cap and keeps the partial results', () => {
    withTempDir((dir) => {
      const skillsRoot = path.join(dir, '.claude', 'skills');
      writeLeafSkills(skillsRoot, SKILL_WALK_MAX_DIRS + 10);

      const discovered = discoverSkills(dir)
        .filter((skill) => skill.path.startsWith(skillsRoot));

      // The root plus SKILL_WALK_MAX_DIRS - 1 leaves are visited.
      expect(discovered).toHaveLength(SKILL_WALK_MAX_DIRS - 1);
    });
  }, 60_000);

  test('discovery is complete for a tree exactly at the directory cap', () => {
    withTempDir((dir) => {
      const skillsRoot = path.join(dir, '.claude', 'skills');
      fs.mkdirSync(skillsRoot, { recursive: true });
      // Empty leaves fill the walk to the cap; the one SKILL.md sits in a
      // leaf, so it is found only if every leaf at the cap is visited.
      for (let i = 0; i < SKILL_WALK_MAX_DIRS - 1; i += 1) {
        fs.mkdirSync(path.join(skillsRoot, `d${String(i).padStart(4, '0')}`));
      }
      const leaf = path.join(skillsRoot, 'd0000');
      fs.writeFileSync(path.join(leaf, 'SKILL.md'), '---\nname: cap-skill-at-bound\n---\n\nbody\n', 'utf8');

      const discovered = discoverSkills(dir)
        .filter((skill) => skill.path.startsWith(skillsRoot));

      expect(discovered.map((skill) => skill.name)).toEqual(['cap-skill-at-bound']);
    });
  }, 60_000);
});

describe('VS Code skill supporting-files caps (#1365)', () => {
  const withTempDir = (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-supporting-'));
    try {
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const writeSkill = (skillDir, supporting) => {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: supporting-skill\n---\n\nbody\n',
      'utf8',
    );
    for (const rel of supporting) {
      const filePath = path.join(skillDir, rel);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'x', 'utf8');
    }
  };

  const sourcesFor = (dir, skillDir) => getSkillSources('supporting-skill', dir, {
    name: 'supporting-skill',
    path: path.join(skillDir, 'SKILL.md'),
    scope: 'user',
    source: 'agents',
  });

  test('pins the same cap values as the web twin in shared.js', () => {
    const webSource = fs.readFileSync(
      new URL('../../web/server/lib/opencode/shared.js', import.meta.url),
      'utf8',
    );
    expect(webSource).toContain('createTraversalBudget({ maxDirs: 5000, maxEntries: 5000 })');
    const ownSource = fs.readFileSync(new URL('./opencodeConfig.ts', import.meta.url), 'utf8');
    expect(ownSource).toContain('createTraversalBudget({ maxDirs: 5000, maxEntries: 5000 })');
  });

  test('lists supporting files under the caps without truncation', () => {
    withTempDir((dir) => {
      const skillDir = path.join(dir, 'supporting-skill');
      writeSkill(skillDir, [path.join('references', 'guide.md'), 'notes.txt']);

      const sources = sourcesFor(dir, skillDir);

      expect(sources.md.supportingFilesTruncated).toBe(false);
      expect(sources.md.supportingFiles.map((file) => file.path).sort()).toEqual([
        'notes.txt',
        path.join('references', 'guide.md'),
      ]);
    });
  });

  test('stops at the directory cap and keeps the files found before it', () => {
    withTempDir((dir) => {
      const skillDir = path.join(dir, 'supporting-skill');
      const supporting = [];
      for (let i = 0; i < 5010; i += 1) {
        supporting.push(path.join(`d${String(i).padStart(4, '0')}`, 'note.txt'));
      }
      writeSkill(skillDir, supporting);

      const sources = sourcesFor(dir, skillDir);

      // The root plus 4,999 leaves are visited; each visited leaf adds one file.
      expect(sources.md.supportingFilesTruncated).toBe(true);
      expect(sources.md.supportingFiles).toHaveLength(4999);
    });
  }, 60_000);

  test('is complete for a tree exactly at the directory cap', () => {
    withTempDir((dir) => {
      const skillDir = path.join(dir, 'supporting-skill');
      writeSkill(skillDir, [path.join('d0000', 'note.txt')]);
      for (let i = 1; i < 4999; i += 1) {
        fs.mkdirSync(path.join(skillDir, `d${String(i).padStart(4, '0')}`), { recursive: true });
      }

      const sources = sourcesFor(dir, skillDir);

      expect(sources.md.supportingFilesTruncated).toBe(false);
      expect(sources.md.supportingFiles.map((file) => file.path)).toEqual([
        path.join('d0000', 'note.txt'),
      ]);
    });
  }, 60_000);

  test('stops at the file cap and keeps the files collected before it', () => {
    withTempDir((dir) => {
      const skillDir = path.join(dir, 'supporting-skill');
      const supporting = [];
      for (let i = 0; i < 5010; i += 1) {
        supporting.push(`f${String(i).padStart(4, '0')}.txt`);
      }
      writeSkill(skillDir, supporting);

      const sources = sourcesFor(dir, skillDir);

      expect(sources.md.supportingFilesTruncated).toBe(true);
      expect(sources.md.supportingFiles).toHaveLength(5000);
    });
  }, 60_000);
});

describe('VS Code parseMdFile size gate (#1157)', () => {
  const withTempDir = (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-md-cap-'));
    try {
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('exports a positive named cap of 4 MiB', () => {
    expect(MD_FILE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  test('refuses an over-cap file with ERR_MD_FILE_TOO_LARGE without parsing it', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'over-cap.md');
      fs.writeFileSync(file, 'a'.repeat(MD_FILE_MAX_BYTES + 1), 'utf8');

      let thrown;
      try {
        parseMdFile(file);
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.code).toBe('ERR_MD_FILE_TOO_LARGE');
      expect(thrown?.message).toContain(String(MD_FILE_MAX_BYTES));
    });
  });

  test('parses a file exactly at the cap byte-identically', () => {
    withTempDir((dir) => {
      const content = 'a'.repeat(MD_FILE_MAX_BYTES);
      const file = path.join(dir, 'at-cap.md');
      fs.writeFileSync(file, content, 'utf8');
      expect(fs.statSync(file).size).toBe(MD_FILE_MAX_BYTES);

      const parsed = parseMdFile(file);

      expect(parsed.frontmatter).toEqual({});
      expect(parsed.body).toBe(content);
    });
  });

  test('parses ordinary frontmatter and keeps missing-file ENOENT behaviour', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'agent.md');
      fs.writeFileSync(file, '---\nname: demo\n---\n\nhello\n', 'utf8');

      const parsed = parseMdFile(file);
      expect(parsed.frontmatter.name).toBe('demo');
      expect(parsed.body).toBe('hello');

      let thrown;
      try {
        parseMdFile(path.join(dir, 'missing.md'));
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).toBe('ENOENT');
    });
  });

  test('refuses a file that grows past the cap after the handle stat without buffering it whole (#1410)', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'grown.md');
      fs.writeFileSync(file, 'a'.repeat(MD_FILE_MAX_BYTES + 1024), 'utf8');

      // The descriptor growth case: the handle stat answers the pre-growth
      // size while the read meets the grown file.
      const originalFstatSync = fs.fstatSync;
      const originalReadSync = fs.readSync;
      let requested = 0;
      fs.fstatSync = (fd) => {
        const stats = originalFstatSync(fd);
        Object.defineProperty(stats, 'size', { value: 16 });
        return stats;
      };
      fs.readSync = (fd, buffer, offset, length, position) => {
        requested += length;
        return originalReadSync(fd, buffer, offset, length, position);
      };

      let thrown;
      try {
        parseMdFile(file);
      } catch (error) {
        thrown = error;
      } finally {
        fs.fstatSync = originalFstatSync;
        fs.readSync = originalReadSync;
      }

      expect(thrown?.code).toBe('ERR_MD_FILE_TOO_LARGE');
      expect(requested).toBeGreaterThan(0);
      expect(requested).toBeLessThanOrEqual(MD_FILE_MAX_BYTES + 1);
    });
  });

  test('refuses a non-regular file without blocking (#1410)', () => {
    withTempDir((dir) => {
      let thrown;
      try {
        parseMdFile(dir);
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.message).toMatch(/not a regular file/);
    });
  });

  test('snippet discovery skips an over-cap file and keeps loading the rest', () => {
    withTempDir((dir) => {
      const snippetsDir = path.join(dir, '.opencode', 'snippets');
      fs.mkdirSync(snippetsDir, { recursive: true });
      fs.writeFileSync(path.join(snippetsDir, 'bigone.md'), 'a'.repeat(MD_FILE_MAX_BYTES + 1), 'utf8');
      fs.writeFileSync(path.join(snippetsDir, 'tiny.md'), 'hello', 'utf8');

      const snippets = listSnippets(dir);

      expect(snippets.map((snippet) => snippet.name)).toEqual(['tiny']);
      expect(snippets[0].content).toBe('hello');
    });
  });
});

describe('VS Code skill update Markdown cap ordering (#1444)', () => {
  test('refuses an over-cap Markdown update before touching supporting files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-update-cap-'));
    try {
      const skillDir = path.join(dir, '.opencode', 'skills', 'guarded-skill');
      fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
      const skillMd = '---\nname: guarded-skill\ndescription: Has supporting files\n---\n\nbody\n';
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
      fs.writeFileSync(path.join(skillDir, 'references', 'keep.md'), 'keep me', 'utf8');

      expect(() => updateSkill('guarded-skill', {
        instructions: 'x'.repeat(MD_FILE_MAX_BYTES + 1),
        supportingFiles: [
          { path: 'references/keep.md', delete: true },
          { path: 'references/new.md', content: 'new' },
        ],
      }, dir)).toThrow(expect.objectContaining({ code: 'ERR_MD_FILE_TOO_LARGE' }));

      expect(fs.readFileSync(path.join(skillDir, 'references', 'keep.md'), 'utf8')).toBe('keep me');
      expect(fs.existsSync(path.join(skillDir, 'references', 'new.md'))).toBe(false);
      expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(skillMd);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('VS Code skill supporting-file sink containment (#2304)', () => {
  const withFixture = (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-sink-containment-'));
    try {
      const skillDir = path.join(dir, 'skills', 'sink-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: sink-skill\n---\n\nbody\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside-secret', 'utf8');
      return run(dir, skillDir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const expectEacces = (fn) => {
    try {
      fn();
    } catch (error) {
      expect(error.code).toBe('EACCES');
      return;
    }
    throw new Error('expected an EACCES refusal');
  };

  test('read refuses a ../.. escape with EACCES', () => {
    withFixture((dir, skillDir) => {
      expectEacces(() => readSkillSupportingFile(skillDir, '../../secret.txt'));
    });
  });

  test('write refuses a ../.. escape with EACCES and creates nothing outside', () => {
    withFixture((dir, skillDir) => {
      expectEacces(() => writeSkillSupportingFile(skillDir, '../../pwned.txt', 'pwned'));
      expect(fs.existsSync(path.join(dir, 'pwned.txt'))).toBe(false);
    });
  });

  test('delete refuses a ../.. escape with EACCES and removes nothing outside', () => {
    withFixture((dir, skillDir) => {
      expectEacces(() => deleteSkillSupportingFile(skillDir, '../../secret.txt'));
      expect(fs.readFileSync(path.join(dir, 'secret.txt'), 'utf8')).toBe('outside-secret');
    });
  });

  test('legitimate nested write/read/delete still work and prune only inside the skill dir', () => {
    withFixture((dir, skillDir) => {
      writeSkillSupportingFile(skillDir, 'docs/deep/guide.md', 'guide');
      expect(readSkillSupportingFile(skillDir, 'docs/deep/guide.md')).toBe('guide');
      deleteSkillSupportingFile(skillDir, 'docs/deep/guide.md');
      expect(fs.existsSync(path.join(skillDir, 'docs'))).toBe(false);
      expect(fs.existsSync(skillDir)).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'secret.txt'), 'utf8')).toBe('outside-secret');
    });
  });
});
