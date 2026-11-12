import './opencodeConfigTestHome';
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUILT_IN_SKILL_LOCATION,
  discoverSkills,
  getSkillSources,
  mergeDiscoveredSkills,
} from './opencodeConfig';

describe('VS Code skill discovery parity', () => {
  test('lists one skill per directory and skips hidden, dependency and nested ones', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-scan-')));
    const write = (relative, name) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`, 'utf8');
    };
    try {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      write('.agents/skills/parent/SKILL.md', 'parent');
      // Inside a skill: OpenCode does not look there for more skills.
      write('.agents/skills/parent/bundled/inner/SKILL.md', 'inner-skill');
      write('.agents/skills/group/node_modules/dep/skills/dep-skill/SKILL.md', 'dep-skill');
      write('.agents/skills/.hidden/hidden-skill/SKILL.md', 'hidden-skill');
      write('.agents/skills/group/child/SKILL.md', 'child');

      const names = discoverSkills(root)
        .filter((skill) => skill.path.startsWith(root))
        .map((skill) => skill.name)
        .sort();

      expect(names).toEqual(['child', 'parent']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A file link needs elevation on Windows.
  test.skipIf(process.platform === 'win32')('treats a linked SKILL.md as the skill and does not search below it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-linked-skill-')));
    const write = (relative, name) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`, 'utf8');
    };
    try {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      write('shared/parent.md', 'parent');
      fs.mkdirSync(path.join(root, '.agents/skills/parent'), { recursive: true });
      fs.symlinkSync(path.join(root, 'shared/parent.md'), path.join(root, '.agents/skills/parent/SKILL.md'));
      write('.agents/skills/parent/bundled/child/SKILL.md', 'nested-child');
      // A grouping folder whose SKILL.md link is dangling still hands down its children.
      fs.mkdirSync(path.join(root, '.agents/skills/group'), { recursive: true });
      fs.symlinkSync(path.join(root, 'missing.md'), path.join(root, '.agents/skills/group/SKILL.md'));
      write('.agents/skills/group/beta/SKILL.md', 'beta');

      const found = discoverSkills(root)
        .filter((skill) => skill.path.startsWith(root))
        .map((skill) => [skill.name, path.relative(root, skill.path).split(path.sep).join('/')])
        .sort((a, b) => a[0].localeCompare(b[0]));

      expect(found).toEqual([
        ['beta', '.agents/skills/group/beta/SKILL.md'],
        ['parent', '.agents/skills/parent/SKILL.md'],
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
