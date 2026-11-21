import './opencodeConfigTestHome';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deletePluginDirFile, listPluginDirFiles, readPluginDirFile, writePluginDirFile } from './opencodeConfig';

describe('plugin file listing', () => {
  test('lists a plugin file reached through a symlink', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-link-'));
    try {
      const pluginDir = path.join(project, '.opencode', 'plugins');
      fs.mkdirSync(pluginDir, { recursive: true });
      const target = path.join(project, 'external-plugin.js');
      fs.writeFileSync(target, 'export default {}', 'utf8');
      try {
        fs.symlinkSync(target, path.join(pluginDir, 'linked.js'), 'file');
      } catch (error) {
        // Windows needs Developer Mode or an elevated shell for a file link.
        // SAFETY: Node attaches the errno code to the Error it throws.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') return;
        throw error;
      }

      const listed = listPluginDirFiles(project).filter((file) => file.scope === 'project');
      assert.deepEqual(listed.map((file) => file.fileName), ['linked.js']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test('keeps the on-disk name of mixed-case and space-led links through every file action', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-names-'));
    try {
      const pluginDir = path.join(project, '.opencode', 'plugins');
      fs.mkdirSync(pluginDir, { recursive: true });
      const names = ['myPlugin.js', ' linked.js', 'linked.js'];
      try {
        for (const name of names) {
          const target = path.join(project, `target-${name.trim()}-${names.indexOf(name)}`);
          fs.writeFileSync(target, `export const name = ${JSON.stringify(name)}`, 'utf8');
          fs.symlinkSync(target, path.join(pluginDir, name), 'file');
        }
      } catch (error) {
        // SAFETY: Node attaches the errno code to the Error it throws.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') return;
        throw error;
      }

      const listed = listPluginDirFiles(project).filter((file) => file.scope === 'project');
      assert.deepEqual(listed.map((file) => file.fileName).sort(), [...names].sort());
      assert.equal(new Set(listed.map((file) => file.id)).size, names.length);
      for (const file of listed) {
        assert.equal(file.absolutePath, path.join(pluginDir, file.fileName));
        assert.equal(file.policyResource, `plugin:${file.absolutePath}`);
        assert.equal(readPluginDirFile(file.id, project)?.content, `export const name = ${JSON.stringify(file.fileName)}`);
      }

      const mixed = listed.find((file) => file.fileName === 'myPlugin.js');
      assert.ok(mixed);
      writePluginDirFile({ fileName: mixed.fileName, scope: 'project', content: 'updated' }, project, { overwrite: true });
      assert.equal(readPluginDirFile(mixed.id, project)?.content, 'updated');
      assert.throws(() => writePluginDirFile({ fileName: 'Other.js', scope: 'project', content: '' }, project), /must match/);
      deletePluginDirFile(mixed.id, project);
      assert.equal(fs.existsSync(path.join(pluginDir, 'myPlugin.js')), false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
