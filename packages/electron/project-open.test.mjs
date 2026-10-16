import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enqueueProjectOpenArguments } from './project-open.mjs';

test('keeps repeated launches distinct and canonicalizes directory aliases', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-project-open-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await fsp.mkdir(path.join(directory, '项目 with spaces'));
  const alias = path.join(directory, 'alias');
  await fsp.symlink(path.join(directory, '项目 with spaces'), alias);
  const queue = [];
  await enqueueProjectOpenArguments(queue, ['app', `--openchamber-project=${alias}`]);
  await enqueueProjectOpenArguments(queue, ['app', `--openchamber-project=${alias}`]);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].directory, await fsp.realpath(alias));
  assert.notEqual(queue[0].id, queue[1].id);
});

test('rejects relative or missing paths without consuming other pending requests', async () => {
  const queue = [{ id: 'previous', directory: '/existing' }];
  await assert.rejects(enqueueProjectOpenArguments(queue, ['--openchamber-project=.']), /absolute path/);
  await assert.rejects(enqueueProjectOpenArguments(queue, [`--openchamber-project=${path.join(os.tmpdir(), 'missing-openchamber-project-778902')}`]), /does not exist/);
  assert.deepEqual(queue, [{ id: 'previous', directory: '/existing' }]);
  assert.equal(await enqueueProjectOpenArguments(queue, ['app', '--background']), false);
});
