import './opencodeConfigTestHome';
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSkillsListResponse } from './skills-list-response';

describe('VS Code skill list response', () => {
  test('reports the .claude switch from the managed OpenCode environment, and none for a server it did not start', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-list-')));
    try {
      expect(buildSkillsListResponse([], root, {}).externalSkills).toEqual({ claudeDisabled: false });

      const managed = buildSkillsListResponse(null, root, { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' });
      expect(managed.externalSkills).toEqual({ claudeDisabled: true });
      expect(managed.openCodeSkillsUnavailable).toBe(true);

      expect(buildSkillsListResponse([], root, null)).not.toHaveProperty('externalSkills');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
