import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import { GIT_LAUNCH_DIRECTORY, spawnOutsideProjects } from './git-launch.js';

it('runs git in a project without starting a process there', async () => {
  const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oc-git-launch-')));
  execFileSync('git', ['init', '-q', project]);
  const starts = [];
  const start = spawnOutsideProjects('git', (command, args, options) => {
    starts.push([command, options.cwd]);
    return spawn(command, args, options);
  });
  const output = (child) => new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.once('close', () => resolve(text.trim()));
  });
  expect(realpathSync(await output(start('git', ['rev-parse', '--show-toplevel'], { cwd: project })))).toBe(project);
  await output(start(process.execPath, ['-e', ''], { cwd: project }));
  expect(starts).toEqual([['git', GIT_LAUNCH_DIRECTORY], [process.execPath, project]]);
  rmSync(project, { recursive: true, force: true });
});
