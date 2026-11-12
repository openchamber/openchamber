// A development build inside a space: the local `web` and `sdk` packages, packed and installed
// by the filler. Runs only with OPENCHAMBER_TEST_DOCKER_PACKED=1, because it compiles the sdk
// and needs the workspace dependencies installed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpaceId, hashProjectDirectory } from '../labels.js';
import { TOOLS_MOUNT_PATH } from '../layout.js';
import { runCommand } from '../run-command.js';
import { createSpaceServerChannel } from '../space-server.js';
import { packLocalTools } from '../tools-pack.js';
import { createPackedToolsSource, readHostToolVersions } from '../tools.js';
import { createLiveDockerPlace } from './docker-live-support.js';

const PACKED_ENABLED = process.env.OPENCHAMBER_TEST_DOCKER_PACKED === '1';
const CREATE_TIMEOUT_MS = 25 * 60_000;

describe.skipIf(!PACKED_ENABLED)('development build inside a space: docker (live)', () => {
  const spec = {
    id: createSpaceId(),
    name: 'Development build',
    project: hashProjectDirectory('/development/build/project'),
    created: new Date().toISOString(),
    memoryBytes: 2 * 1024 * 1024 * 1024,
  };
  let directory;
  let place;
  let host;
  let dispose = async () => {};

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-packed-test-'));
    const tarballs = await packLocalTools({ runCommand, outputDirectory: directory });
    const toolsSource = createPackedToolsSource({ ...tarballs, openCodeVersion: readHostToolVersions().openCodeVersion });
    ({ place, host, dispose } = createLiveDockerPlace({ toolsSource }));
    await place.create(spec);
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    await dispose();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('is healthy and verifies clean', async () => {
    const health = await createSpaceServerChannel({ exec: place.exec }).request(spec.id, { path: '/health' });
    expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });
    expect(await place.verify(spec.id)).toEqual([]);
  });

  it('labels the tools volume as a development build', async () => {
    const [volume] = (await host.volumes()).filter((name) => name.startsWith('openchamber-tools-'));
    const inspect = await runCommand('docker', ['volume', 'inspect', volume]);
    expect(JSON.parse(inspect.stdout)[0].Labels['openchamber.space.tools.description']).toBe('development build');
  });

  it('runs the local sdk everywhere in the tree, not the published one with the same version', async () => {
    const sdk = fs.readFileSync(new URL('../../../../../sdk/package.json', import.meta.url), 'utf8');
    const copies = await place.exec(spec.id, ['sh', '-c', `find ${TOOLS_MOUNT_PATH}/node_modules -type d -path '*/@openchamber/sdk' -not -path '*/sdk/*'`]);
    expect(copies.stdout).toBe(`${TOOLS_MOUNT_PATH}/node_modules/@openchamber/sdk\n`);

    // The lock file names where each package came from: the sdk from the local tarball, never from the registry.
    const lock = JSON.parse((await place.exec(spec.id, ['cat', `${TOOLS_MOUNT_PATH}/package-lock.json`])).stdout);
    const installed = lock.packages['node_modules/@openchamber/sdk'];
    expect(installed.version).toBe(JSON.parse(sdk).version);
    expect(installed.resolved).toMatch(/^file:.*openchamber-sdk\.tgz$/);
    expect(lock.packages['node_modules/@openchamber/web'].resolved).toMatch(/^file:.*openchamber-web\.tgz$/);
  });

  it('leaves the tarballs out of the volume', async () => {
    const found = await place.exec(spec.id, ['sh', '-c', `find ${TOOLS_MOUNT_PATH} -maxdepth 1 -name '*.tgz'`]);
    expect(found).toMatchObject({ code: 0, stdout: '' });
  });
});
