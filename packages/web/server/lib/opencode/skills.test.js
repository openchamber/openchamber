import { describe, expect, it } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { discoverSkills, getSkillSources, mergeDiscoveredSkills, renameSkill, updateSkill } from './skills.js';

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

      const discovered = await discoverSkills(tempRoot);
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

  describe('discovery over a tree with nested skills and links', () => {
    // Expected values were recorded from the synchronous discovery on main
    // before it became async; they must not move.
    const buildTree = async () => {
      const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skill-equiv-')));
      const write = async (relative, frontmatter) => {
        const file = path.join(root, relative);
        await fsPromises.mkdir(path.dirname(file), { recursive: true });
        await fsPromises.writeFile(file, `---\n${frontmatter}\n---\nBody\n`, 'utf8');
      };
      const skill = (relative, name) => write(relative, `name: ${name}\ndescription: ${name} description`);
      // A junction needs no elevation on Windows; the type is ignored on POSIX.
      const link = async (target, relative) => {
        await fsPromises.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fsPromises.symlink(path.join(root, target), path.join(root, relative), process.platform === 'win32' ? 'junction' : 'dir');
      };
      await skill('home/.agents/skills/alpha/SKILL.md', 'alpha');
      await skill('home/.agents/skills/alpha/nested/inner/SKILL.md', 'alpha-inner');
      await skill('home/.agents/skills/group/beta/SKILL.md', 'beta');
      await write('home/.agents/skills/broken/SKILL.md', 'description: no name');
      await skill('outside/gamma/SKILL.md', 'gamma');
      await link('outside/gamma', 'home/.agents/skills/linked-gamma');
      await link('home/.agents/skills', 'home/.agents/skills/loop/back');
      await link('home/.agents/skills/alpha', 'home/.claude/skills/alpha');
      await skill('home/.claude/skills/delta/SKILL.md', 'delta');
      await skill('home/.claude/skills/delta/.venv/lib/pkg/SKILL.md', 'venv-skill');
      await fsPromises.mkdir(path.join(root, 'home/work/project/.git'), { recursive: true });
      await skill('home/work/project/.agents/skills/proj/SKILL.md', 'proj');
      await skill('home/work/project/.opencode/skills/oc/SKILL.md', 'oc');
      await skill('home/work/project/.claude/skills/delta/SKILL.md', 'delta');
      return root;
    };

    const withHome = async (home, run) => {
      const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        return await run();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    // Skills of the machine running the tests (global config, caches) are
    // outside the tree and left out.
    const discoveredIn = async (root, directory) => (await discoverSkills(directory))
      .filter((skill) => skill.path.startsWith(root))
      .map((skill) => [skill.name, path.relative(root, skill.path).split(path.sep).join('/'), skill.scope, skill.source])
      .sort((a, b) => a[0].localeCompare(b[0]));

    const userSkills = (scope) => [
      ['alpha', 'home/.agents/skills/alpha/SKILL.md', scope, 'agents'],
      ['alpha-inner', 'home/.agents/skills/alpha/nested/inner/SKILL.md', scope, 'agents'],
      ['beta', 'home/.agents/skills/group/beta/SKILL.md', scope, 'agents'],
      ['delta', 'home/.claude/skills/delta/SKILL.md', scope, 'claude'],
      ['gamma', 'home/.agents/skills/linked-gamma/SKILL.md', scope, 'agents'],
      ['venv-skill', 'home/.claude/skills/delta/.venv/lib/pkg/SKILL.md', scope, 'claude'],
    ];

    it('finds the same skills as before for a project, a home-directory project and no project', async () => {
      const root = await buildTree();
      const home = path.join(root, 'home');
      try {
        await withHome(home, async () => {
          expect(await discoveredIn(root, path.join(home, 'work', 'project'))).toEqual([
            ['alpha', 'home/.agents/skills/alpha/SKILL.md', 'user', 'agents'],
            ['alpha-inner', 'home/.agents/skills/alpha/nested/inner/SKILL.md', 'user', 'agents'],
            ['beta', 'home/.agents/skills/group/beta/SKILL.md', 'user', 'agents'],
            ['delta', 'home/work/project/.claude/skills/delta/SKILL.md', 'project', 'claude'],
            ['gamma', 'home/.agents/skills/linked-gamma/SKILL.md', 'user', 'agents'],
            ['oc', 'home/work/project/.opencode/skills/oc/SKILL.md', 'project', 'opencode'],
            ['proj', 'home/work/project/.agents/skills/proj/SKILL.md', 'project', 'agents'],
            ['venv-skill', 'home/.claude/skills/delta/.venv/lib/pkg/SKILL.md', 'user', 'claude'],
          ]);
          // The home directory's own skill roots are read once but still
          // land as project skills, the way the second pass always left them.
          expect(await discoveredIn(root, home)).toEqual(userSkills('project'));
          expect(await discoveredIn(root, null)).toEqual(userSkills('user'));
        });
      } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
      }
    });

    it('lets other work run while it reads the tree', async () => {
      const root = await buildTree();
      const events = [];
      try {
        await withHome(path.join(root, 'home'), async () => {
          const discovery = discoverSkills(path.join(root, 'home', 'work', 'project')).then(() => events.push('discovered'));
          setImmediate(() => events.push('other work'));
          await discovery;
        });
        expect(events).toEqual(['other work', 'discovered']);
      } finally {
        await fsPromises.rm(root, { recursive: true, force: true });
      }
    });
  });

  it('resolves built-in OpenCode skill content without parsing virtual locations as files', async () => {
    const sources = await getSkillSources(
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

  it('clears file metadata when a discovered skill path is unreadable', async () => {
    const missingPath = path.join(os.tmpdir(), 'openchamber-skills-test-missing-file', 'SKILL.md');
    const sources = await getSkillSources(
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

      const sources = await getSkillSources('example-skill', tempRoot, {
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

  it('writes and clears "run only when called" as both frontmatter keys, keeping other metadata', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-invocation-'));
    const skillDir = path.join(tempRoot, 'manual-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const discovered = { name: 'manual-skill', path: skillPath, scope: 'user', source: 'agents' };
    const readFrontmatter = async () => {
      const content = await fsPromises.readFile(skillPath, 'utf8');
      return yaml.parse(content.split('---')[1]);
    };

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(
        skillPath,
        ['---', 'name: manual-skill', 'description: Manual', 'metadata:', '  team: core', '---', '', 'Body.', ''].join('\n'),
        'utf8',
      );
      expect((await getSkillSources('manual-skill', tempRoot, discovered)).md.disableModelInvocation).toBe(false);

      await updateSkill('manual-skill', { disableModelInvocation: true }, tempRoot, skillPath);
      expect(await readFrontmatter()).toEqual({
        name: 'manual-skill',
        description: 'Manual',
        metadata: { team: 'core', 'opencode/autoinvoke': false },
        'disable-model-invocation': true,
      });
      expect((await getSkillSources('manual-skill', tempRoot, discovered)).md.disableModelInvocation).toBe(true);

      await updateSkill('manual-skill', { disableModelInvocation: false }, tempRoot, skillPath);
      expect(await readFrontmatter()).toEqual({
        name: 'manual-skill',
        description: 'Manual',
        metadata: { team: 'core' },
      });
      expect((await getSkillSources('manual-skill', tempRoot, discovered)).md.disableModelInvocation).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reads the invocation flag the way OpenCode does: opencode/autoinvoke wins', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-skills-invocation-read-'));
    const skillDir = path.join(tempRoot, 'read-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const discovered = { name: 'read-skill', path: skillPath, scope: 'user', source: 'agents' };
    const disabledFor = async (frontmatterLines) => {
      await fsPromises.writeFile(
        skillPath,
        ['---', 'name: read-skill', 'description: Read', ...frontmatterLines, '---', '', 'Body.', ''].join('\n'),
        'utf8',
      );
      return (await getSkillSources('read-skill', tempRoot, discovered)).md.disableModelInvocation;
    };

    try {
      await fsPromises.mkdir(skillDir, { recursive: true });
      expect(await disabledFor(['disable-model-invocation: "yes"'])).toBe(true);
      expect(await disabledFor(['metadata:', '  opencode/autoinvoke: "false"'])).toBe(true);
      expect(await disabledFor(['disable-model-invocation: true', 'metadata:', '  opencode/autoinvoke: true'])).toBe(false);
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

      await renameSkill('original-skill', 'renamed-skill', projectRoot);

      const renamedDir = path.join(projectRoot, '.opencode', 'skills', 'renamed-skill');
      const renamedPath = path.join(renamedDir, 'SKILL.md');
      const renamedSupportPath = path.join(renamedDir, 'notes.md');

      expect(fs.existsSync(skillDir)).toBe(false);
      expect(fs.existsSync(renamedPath)).toBe(true);
      expect(fs.existsSync(renamedSupportPath)).toBe(true);

      const sources = await getSkillSources('renamed-skill', projectRoot, {
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

      await expect(renameSkill('rollback-skill', 'rollback-skill-renamed', projectRoot)).rejects.toThrow();

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

      await expect(renameSkill('managed-skill', 'Invalid_Name', projectRoot)).rejects.toThrow(/Invalid skill name/);
      await expect(renameSkill('missing-skill', 'new-skill', projectRoot)).rejects.toThrow(/not found/);
      await expect(renameSkill('managed-skill', 'taken-name', projectRoot)).rejects.toThrow(/already exists/);
      await expect(renameSkill('folder-name', 'renamed-mismatch', projectRoot)).rejects.toThrow(/does not match/);
      await expect(renameSkill('cache-skill', 'cache-skill-renamed', projectRoot)).rejects.toThrow(/managed skill directories/);

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
