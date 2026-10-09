import { describe, expect, it } from 'vitest';

import { buildSpaceLabels, buildToolsLabels, hashProjectDirectory } from '../labels.js';
import { createRegistryToolsSource, toolsContentKey } from '../tools.js';
import { parseDockerSize } from './docker-disk.js';
import { RETIRED_SPACE_BASE_IMAGES, SPACE_BASE_IMAGE, createDockerPlace } from './docker.js';
import { createFakeDocker, hardenedContainerEntry } from './fake-docker.js';

const OWNER = 'install-a';
const STRANGER = 'install-b';
const SOURCE = createRegistryToolsSource({ webVersion: '1.24.2', openCodeVersion: '1.18.31' });
const KEY = toolsContentKey(SOURCE, SPACE_BASE_IMAGE);
const OLD_KEY = '0123456789abcdef';
const OLDER_KEY = 'fedcba9876543210';
const NOW = new Date('2026-09-30T08:00:00.000Z');
const ID = 'a1b2c3d4e5f6';

const toolsName = (owner, key) => `openchamber-tools-${owner}-${key}`;
const toolsVolume = (owner, key) => ({
  kind: 'volume',
  name: toolsName(owner, key),
  entry: { Name: toolsName(owner, key), Labels: buildToolsLabels({ role: 'tools', owner, key, description: 'web 1.24.2', created: NOW.toISOString() }) },
  filled: true,
});
const oneShot = (key, { running }) => {
  const name = `${toolsName(OWNER, key)}-fill`;
  const labels = buildToolsLabels({ role: 'tools-fill', owner: OWNER, key, description: 'web 1.24.2', created: NOW.toISOString() });
  return { kind: 'container', name, entry: hardenedContainerEntry({ name, labels, network: 'bridge', mounts: [], running }) };
};
const spaceLabels = (role) => buildSpaceLabels({ id: ID, role, owner: OWNER, project: hashProjectDirectory('/home/me/project'), name: 'Fix it', created: NOW.toISOString() });
/** A stopped space of ours on the tools of `key`, with its two volumes. */
const stoppedSpace = (key) => {
  const name = `openchamber-space-${ID}-space`;
  const work = `openchamber-space-${ID}-volume-work`;
  const home = `openchamber-space-${ID}-volume-home`;
  return [
    { kind: 'container', name, entry: hardenedContainerEntry({ name, labels: spaceLabels('space'), network: `openchamber-space-${ID}-network`, running: false, mounts: [{ volume: work, destination: `/spaces/${ID}` }, { volume: home, destination: '/home/space' }, { volume: toolsName(OWNER, key), destination: '/opt/openchamber-tools', readOnly: true }] }) },
    { kind: 'volume', name: work, entry: { Name: work, Labels: spaceLabels('volume') } },
    { kind: 'volume', name: home, entry: { Name: home, Labels: spaceLabels('volume') } },
  ];
};
const strangerContainer = (image) => ({ kind: 'container', name: 'their-app', entry: hardenedContainerEntry({ name: 'their-app', labels: {}, network: 'bridge', mounts: [{ volume: 'their-data', destination: '/data' }], running: false, image }) });
const strangerVolume = { kind: 'volume', name: 'their-data', entry: { Name: 'their-data', Labels: {} } };

const SIZES = {
  [toolsName(OWNER, KEY)]: '438MB',
  [toolsName(OWNER, OLD_KEY)]: '440MB',
  [toolsName(OWNER, OLDER_KEY)]: '441MB',
  [toolsName(STRANGER, OLD_KEY)]: '439MB',
  [`openchamber-space-${ID}-volume-work`]: '1.2GB',
  [`openchamber-space-${ID}-volume-home`]: '300MB',
  'their-data': '5GB',
};

const makePlace = (fake, options = {}) => createDockerPlace({ runCommand: fake.runCommand, dockerPath: '/usr/bin/docker', owner: OWNER, toolsSource: SOURCE, wait: fake.wait, now: fake.now, ...options });
const removals = (fake) => fake.calls.map((call) => call.args).filter((args) => args[0] === 'rm' || args[1] === 'rm');

describe('parseDockerSize', () => {
  it('reads the decimal units docker system df prints, and counts anything else as nothing', () => {
    expect(parseDockerSize('438MB')).toBe(438_000_000);
    expect(parseDockerSize('1.632GB')).toBe(1_632_000_000);
    expect(parseDockerSize('4.1kB')).toBe(4_100);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('N/A')).toBe(0);
    expect(parseDockerSize(undefined)).toBe(0);
  });
});

describe('the disk of the Docker place', () => {
  it('counts this owner\'s image, tools and space volumes, and frees only what nothing uses', async () => {
    const fake = createFakeDocker({
      volumeSizes: SIZES,
      resources: [toolsVolume(OWNER, KEY), toolsVolume(OWNER, OLD_KEY), toolsVolume(OWNER, OLDER_KEY), toolsVolume(STRANGER, OLD_KEY), ...stoppedSpace(OLDER_KEY), strangerVolume],
    });
    expect(await makePlace(fake).readDisk()).toEqual({
      imageBytes: 1_632_000_000,
      imagePulling: false,
      imageFailure: null,
      toolsBytes: 438_000_000 + 440_000_000 + 441_000_000,
      spacesBytes: 1_500_000_000,
      // The old tools nothing mounts; the image and the tools the stopped space holds are in use.
      freeBytes: 440_000_000,
      freesImage: false,
    });
  });

  it('frees the image when no container at all was made from it, and says nothing when it is not there', async () => {
    const fake = createFakeDocker({ volumeSizes: SIZES, resources: [toolsVolume(OWNER, KEY)] });
    expect(await makePlace(fake).readDisk()).toMatchObject({ imageBytes: 1_632_000_000, freeBytes: 1_632_000_000, freesImage: true });
    const without = createFakeDocker({ imagePresent: false, resources: [toolsVolume(OWNER, KEY)] });
    expect(await makePlace(without).readDisk()).toMatchObject({ imageBytes: null, freeBytes: 0, freesImage: false });
  });

  it('downloads the image once for everyone who asks, says so on the disk, and remembers a failed download while the image is absent', async () => {
    const fake = createFakeDocker({ imagePresent: false, resources: [toolsVolume(OWNER, KEY)] });
    let release = null;
    let pulls = 0;
    const runCommand = (file, args, options) => {
      if (args[0] !== 'pull') return fake.runCommand(file, args, options);
      pulls += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    const place = makePlace(fake, { runCommand });
    const first = place.pullImage();
    const second = place.pullImage();
    expect(second).toBe(first);
    expect(place.imagePulling()).toBe(true);
    expect(await place.readDisk()).toMatchObject({ imageBytes: null, imagePulling: true, imageFailure: null });
    release({ code: 1, stdout: '', stderr: 'no route to host\n' });
    await expect(first).rejects.toMatchObject({ code: 'image_pull_failed' });
    expect(pulls).toBe(1);
    expect(place.imagePulling()).toBe(false);
    expect(await place.readDisk()).toMatchObject({ imagePulling: false, imageFailure: { code: 'image_pull_failed', message: expect.stringContaining('no route to host') } });
    // The next download is a fresh one, and its success clears the failure.
    const third = place.pullImage();
    release({ code: 0, stdout: '', stderr: '' });
    await third;
    expect(pulls).toBe(2);
    expect(await place.readDisk()).toMatchObject({ imagePulling: false, imageFailure: null });
  });

  it('a failed read rejects rather than answering an empty disk', async () => {
    const fake = createFakeDocker({ failAt: (args) => args[0] === 'system' });
    await expect(makePlace(fake).readDisk()).rejects.toMatchObject({ code: 'docker_command_failed' });
  });
});

describe('clean-up of the Docker place', () => {
  it('removes this owner\'s unused old tools, stopped one-shots and the unused image, without force', async () => {
    const fake = createFakeDocker({
      volumeSizes: SIZES,
      resources: [toolsVolume(OWNER, KEY), toolsVolume(OWNER, OLD_KEY), oneShot(OLD_KEY, { running: false })],
    });
    const outcome = await makePlace(fake).cleanUpDisk();
    expect(outcome).toEqual({ freedBytes: 440_000_000 + 1_632_000_000, kept: [], machine: { state: 'skipped' } });
    expect(fake.names()).toEqual([`volume:${toolsName(OWNER, KEY)}`]);
    expect(fake.imagePresent()).toBe(false);
    expect(removals(fake).some((args) => args.includes('--force'))).toBe(false);
  });

  it('never touches the current tools, another owner\'s tools, a stranger\'s volume, or anything in use', async () => {
    const fake = createFakeDocker({
      volumeSizes: SIZES,
      resources: [
        toolsVolume(OWNER, KEY),
        toolsVolume(OWNER, OLDER_KEY),
        toolsVolume(STRANGER, OLD_KEY),
        ...stoppedSpace(OLDER_KEY),
        oneShot(OLD_KEY, { running: true }),
        strangerVolume,
        strangerContainer('postgres:17'),
      ],
    });
    const before = fake.names();
    const outcome = await makePlace(fake).cleanUpDisk();
    // Docker refused each one: the stopped space holds its tools and the image, and a fill is running.
    expect(outcome.freedBytes).toBe(0);
    expect(outcome.kept).toEqual([
      expect.objectContaining({ kind: 'container', name: `${toolsName(OWNER, OLD_KEY)}-fill`, reason: 'in_use' }),
      expect.objectContaining({ kind: 'tools', name: toolsName(OWNER, OLDER_KEY), reason: 'in_use' }),
      expect.objectContaining({ kind: 'image', name: SPACE_BASE_IMAGE, reason: 'in_use' }),
    ]);
    expect(fake.names()).toEqual(before);
    expect(fake.imagePresent()).toBe(true);
    // Only our own resources and the one pinned image were ever asked to go.
    expect(removals(fake).map((args) => args[args.length - 1])).toEqual([`${toolsName(OWNER, OLD_KEY)}-fill`, toolsName(OWNER, OLDER_KEY), SPACE_BASE_IMAGE]);
  });

  it('keeps the image while a stranger\'s container was made from it', async () => {
    const fake = createFakeDocker({ resources: [toolsVolume(OWNER, KEY), strangerContainer(SPACE_BASE_IMAGE)] });
    expect((await makePlace(fake).cleanUpDisk()).kept).toEqual([expect.objectContaining({ kind: 'image', reason: 'in_use' })]);
    expect(fake.imagePresent()).toBe(true);
  });

  describe('a retired space image', () => {
    const RETIRED = RETIRED_SPACE_BASE_IMAGES[0];
    const RETIRED_BYTES = 1_600_000_000;
    // The gatekeeper of a space created before the bump, still on the image it was made from.
    const oldGatekeeper = { kind: 'container', name: `openchamber-space-${ID}-gatekeeper`, entry: hardenedContainerEntry({ name: `openchamber-space-${ID}-gatekeeper`, labels: spaceLabels('gatekeeper'), network: `openchamber-space-${ID}-network`, mounts: [], running: false, image: RETIRED }) };

    it('is counted in what a clean-up frees and nowhere else, and removed without force', async () => {
      const fake = createFakeDocker({ imagePresent: false, retiredImages: [{ name: RETIRED, bytes: RETIRED_BYTES }], resources: [toolsVolume(OWNER, KEY)] });
      const place = makePlace(fake);
      expect(await place.readDisk()).toEqual({ imageBytes: null, imagePulling: false, imageFailure: null, toolsBytes: 0, spacesBytes: 0, freeBytes: RETIRED_BYTES, freesImage: false });
      expect(await place.cleanUpDisk()).toEqual({ freedBytes: RETIRED_BYTES, kept: [], machine: { state: 'skipped' } });
      expect(fake.retiredImagePresent(RETIRED)).toBe(false);
      expect(removals(fake).some((args) => args.includes('--force'))).toBe(false);
    });

    it('stays while a container made from it exists, and goes once that container is gone', async () => {
      const fake = createFakeDocker({ imagePresent: false, retiredImages: [{ name: RETIRED, bytes: RETIRED_BYTES }], resources: [toolsVolume(OWNER, KEY), oldGatekeeper] });
      const place = makePlace(fake);
      expect((await place.readDisk()).freeBytes).toBe(0);
      const outcome = await place.cleanUpDisk();
      expect(outcome.freedBytes).toBe(0);
      expect(outcome.kept).toEqual([expect.objectContaining({ kind: 'image', name: RETIRED, reason: 'in_use' })]);
      expect(fake.retiredImagePresent(RETIRED)).toBe(true);

      // The old space is deleted, which takes its gatekeeper with it.
      expect((await fake.runCommand('/usr/bin/docker', ['rm', oldGatekeeper.name], {})).code).toBe(0);
      expect((await place.readDisk()).freeBytes).toBe(RETIRED_BYTES);
      expect((await place.cleanUpDisk()).freedBytes).toBe(RETIRED_BYTES);
      expect(fake.retiredImagePresent(RETIRED)).toBe(false);
    });

    it('is left alone, uncounted and never asked to go, when it carries a tag of its own', async () => {
      const fake = createFakeDocker({ imagePresent: false, retiredImages: [{ name: RETIRED, bytes: RETIRED_BYTES, tags: [RETIRED, 'node:22-bookworm'] }], resources: [toolsVolume(OWNER, KEY)] });
      const place = makePlace(fake);
      expect((await place.readDisk()).freeBytes).toBe(0);
      expect(await place.cleanUpDisk()).toEqual({ freedBytes: 0, kept: [], machine: { state: 'skipped' } });
      expect(fake.retiredImagePresent(RETIRED)).toBe(true);
      expect(removals(fake)).toEqual([]);
    });

    it('is counted as gone when it is not there', async () => {
      const fake = createFakeDocker({ imagePresent: false, resources: [toolsVolume(OWNER, KEY)] });
      const place = makePlace(fake);
      expect((await place.readDisk()).freeBytes).toBe(0);
      expect(await place.cleanUpDisk()).toEqual({ freedBytes: 0, kept: [], machine: { state: 'skipped' } });
      expect(removals(fake)).toEqual([]);
    });
  });

  it('on Colima asks the machine to trim its disks after something went, and on any other engine does not', async () => {
    const colimaCalls = [];
    const fake = createFakeDocker({
      engineName: 'colima-work',
      resources: [toolsVolume(OWNER, KEY)],
      colima: (args) => { colimaCalls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    });
    expect((await makePlace(fake, { colimaPath: '/opt/homebrew/bin/colima' }).cleanUpDisk()).machine).toEqual({ state: 'trimmed' });
    expect(colimaCalls).toEqual([['ssh', '--profile', 'work', '--', 'sudo', '-n', 'fstrim', '--all']]);

    const desktop = createFakeDocker({ resources: [toolsVolume(OWNER, KEY)], colima: () => { throw new Error('must not run'); } });
    expect((await makePlace(desktop, { colimaPath: '/opt/homebrew/bin/colima' }).cleanUpDisk()).machine).toEqual({ state: 'skipped' });
  });

  it('a trim that fails or finds nothing to do never fails the clean-up', async () => {
    const fake = createFakeDocker({ engineName: 'colima', resources: [toolsVolume(OWNER, KEY)], colima: () => ({ code: 1, stdout: '', stderr: 'sudo: a password is required' }) });
    const outcome = await makePlace(fake, { colimaPath: '/opt/homebrew/bin/colima' }).cleanUpDisk();
    expect(outcome).toMatchObject({ freedBytes: 1_632_000_000, machine: { state: 'failed', message: 'sudo: a password is required' } });

    const idle = createFakeDocker({ engineName: 'colima', imagePresent: false, resources: [toolsVolume(OWNER, KEY)], colima: () => { throw new Error('must not run'); } });
    expect((await makePlace(idle, { colimaPath: '/opt/homebrew/bin/colima' }).cleanUpDisk()).machine).toEqual({ state: 'skipped' });
  });
});
