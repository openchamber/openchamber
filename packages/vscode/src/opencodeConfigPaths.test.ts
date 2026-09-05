import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('./opencodeConfigPaths.ts', import.meta.url).href;
const configUrl = new URL('./opencodeConfig.ts', import.meta.url).href;

test('unset and blank XDG keep the existing global directory', () => {
  for (const value of [undefined, '', '   ']) {
    const env = { ...process.env };
    if (value === undefined) delete env.XDG_CONFIG_HOME;
    else env.XDG_CONFIG_HOME = value;
    const result = spawnSync(process.execPath, ['--eval', `
      const { OPENCODE_CONFIG_DIR } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(OPENCODE_CONFIG_DIR);
    `], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, path.join(os.homedir(), '.config', 'opencode'));
  }
});

test('global CRUD uses XDG while project writes stay in the project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-xdg-'));
  const configHome = path.join(root, 'config');
  const project = path.join(root, 'project');
  try {
    const result = spawnSync(process.execPath, ['--eval', `
      const { createAgent, createCommand, createSkill } = await import(${JSON.stringify(configUrl)});
      const project = ${JSON.stringify(project)};
      for (const scope of ['user', 'project']) {
        createAgent(scope + '-agent', { description: 'Test', prompt: 'Test prompt' }, project, scope);
        createCommand(scope + '-command', { description: 'Test', template: 'Test command' }, project, scope);
        createSkill(scope + '-skill', { description: 'Test', instructions: 'Test skill' }, project, scope);
      }
    `], {
      env: { ...process.env, XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const [scope, directory] of [['user', path.join(configHome, 'opencode')], ['project', path.join(project, '.opencode')]]) {
      assert.match(fs.readFileSync(path.join(directory, 'agents', `${scope}-agent.md`), 'utf8'), /Test prompt/);
      assert.match(fs.readFileSync(path.join(directory, 'commands', `${scope}-command.md`), 'utf8'), /Test command/);
      assert.match(fs.readFileSync(path.join(directory, 'skills', `${scope}-skill`, 'SKILL.md'), 'utf8'), /Test skill/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
