
import type { RunCommand } from '../command-contracts.js';
import { spaceErrorProperty } from '../errors.js';
import { labelFilterArgs, parseSpaceLabels, ROLE_VOLUME } from '../labels.js';
import type { DockerEngine, DockerRemovalFailure } from './docker-engine.js';
import type { createDockerTools } from './docker-tools.js';
import { parseDockerJson } from './docker-wire.js';

const QUERY_TIMEOUT_MS = 60_000;
const TRIM_TIMEOUT_MS = 120_000;
const SIZE_UNITS = new Map([['B', 1], ['kB', 1e3], ['KB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12], ['PB', 1e15]]);
const IN_USE = /\bis in use\b|\bbeing used by\b|\bmust be forced\b|\bcontainer is running\b/i;
const COLIMA_MACHINE = /^colima(?:-([A-Za-z0-9._-]+))?$/;

export const parseDockerSize = (text: string | null | undefined) => {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|PB)$/.exec(String(text ?? '').trim());
  return match ? Math.round(Number(match[1]) * (SIZE_UNITS.get(match[2] ?? '') ?? Number.NaN)) : 0;
};

export interface ImagePullState {
  pulling: boolean;
  failure: { code: unknown; message: unknown } | null;
}

interface ImageState {
  name: string;
  bytes: number;
  inUse: boolean;
  tags: string[];
}

export interface KeptResource {
  kind: string;
  name: string;
  reason: 'in_use' | 'failed';
  message: unknown;
}

export interface DockerDiskOptions {
  engine: DockerEngine;
  runCommand: RunCommand;
  colimaPath: string | null;
  owner: string;
  image: string;
  retiredImages?: string[];
  tools: ReturnType<typeof createDockerTools>;
  imagePullState?: () => ImagePullState;
}

export function createDockerDisk({ engine, runCommand, colimaPath, owner, image, retiredImages = [], tools, imagePullState = () => ({ pulling: false, failure: null }) }: DockerDiskOptions) {
  const readUsage = async () => {
    const usage = parseDockerJson<'system df'>(await engine.docker(['system', 'df', '--verbose', '--format', '{{json .}}'], QUERY_TIMEOUT_MS)) ?? {};
    return {
      volumes: new Map((usage.Volumes ?? []).map((volume) => [String(volume.Name), { bytes: parseDockerSize(volume.Size), links: Number.parseInt(String(volume.Links), 10) || 0 }])),
      images: new Map((usage.Images ?? []).map((entry) => [String(entry.ID), parseDockerSize(entry.UniqueSize)])),
    };
  };

  const spaceVolumes = async () => (await engine.findByLabel('volume', labelFilterArgs({ owner })))
    .flatMap((entry) => {
      const labels = parseSpaceLabels(entry.Labels);
      return labels?.owner === owner && labels.role === ROLE_VOLUME ? [{ name: String(entry.Name), spaceId: labels.id }] : [];
    });

  const readImage = async (name: string, images: Map<string, number>): Promise<ImageState | null> => {
    const entry = await engine.inspect('image', name);
    if (!entry) return null;
    const users = await engine.docker(['ps', '--all', '--filter', `ancestor=${name}`, '--format', '{{.Names}}'], QUERY_TIMEOUT_MS);
    return { name, bytes: images.get(String(entry.Id)) ?? 0, inUse: users.trim() !== '', tags: entry.RepoTags ?? [] };
  };

  const readRetiredImages = async (images: Map<string, number>) => {
    const found = await Promise.all(retiredImages.map((name) => readImage(name, images)));
    return found.filter((state): state is ImageState => state !== null && state.tags.every((tag) => tag === state.name));
  };

  const measure = async () => {
    const [usage, ours, spaces] = await Promise.all([readUsage(), tools.listOurs(), spaceVolumes()]);
    const { volumes } = usage;
    const sizeOf = (name: string) => volumes.get(name)?.bytes ?? 0;
    const oldTools = ours.volumes.filter((name) => name !== ours.current);
    const [imageState, retired] = await Promise.all([readImage(image, usage.images), readRetiredImages(usage.images)]);
    return { volumes, ours, oldTools, spaces, image: imageState, retired, sizeOf };
  };

  const read = async () => {
    const { volumes, ours, oldTools, spaces, image: imageState, retired, sizeOf } = await measure();
    const freeTools = oldTools.filter((name) => (volumes.get(name)?.links ?? 0) === 0);
    const freesImage = imageState !== null && !imageState.inUse;
    const freeRetired = retired.filter((state) => !state.inUse).reduce((total, state) => total + state.bytes, 0);
    const sum = (names: string[]) => names.reduce((total, name) => total + sizeOf(name), 0);
    const bytesBySpace: Record<string, number> = {};
    for (const volume of spaces) bytesBySpace[volume.spaceId] = (bytesBySpace[volume.spaceId] ?? 0) + sizeOf(volume.name);
    const pull = imagePullState();
    return {
      imageBytes: imageState?.bytes ?? null,
      imagePulling: pull.pulling,
      imageFailure: imageState === null && !pull.pulling ? pull.failure : null,
      toolsBytes: sum(ours.volumes),
      spacesBytes: sum(spaces.map((volume) => volume.name)),
      bytesBySpace,
      freeBytes: sum(freeTools) + (freesImage && imageState !== null ? imageState.bytes : 0) + freeRetired,
      freesImage,
    };
  };

  const trimMachine = async () => {
    if (!colimaPath) return { state: 'skipped' };
    try {
      const info = await engine.run(['info', '--format', '{{json .Name}}'], QUERY_TIMEOUT_MS);
      const match = info.code === 0 ? COLIMA_MACHINE.exec(String(parseDockerJson<'info name'>(info.stdout))) : null;
      if (!match) return { state: 'skipped' };
      const result = await runCommand(colimaPath, ['ssh', '--profile', match[1] ?? 'default', '--', 'sudo', '-n', 'fstrim', '--all'], { timeoutMs: TRIM_TIMEOUT_MS });
      return result.code === 0 ? { state: 'trimmed' } : { state: 'failed', message: result.stderr.trim().slice(-500) || `exit code ${result.code}` };
    } catch (error) {
      return { state: 'failed', message: spaceErrorProperty(error, 'message') ?? String(error) };
    }
  };

  const cleanUp = async () => {
    const { oldTools, ours, image: imageState, retired, sizeOf } = await measure();
    let freedBytes = 0;
    const kept: KeptResource[] = [];
    const attempt = async (kind: string, name: string, bytes: number, removal: Promise<DockerRemovalFailure | null>) => {
      const problem = await removal;
      if (!problem) {
        freedBytes += bytes;
        return true;
      }
      kept.push({ kind, name, reason: IN_USE.test(`${problem.message}`) ? 'in_use' : 'failed', message: problem.message });
      return false;
    };
    let removedAny = false;
    for (const name of ours.oneShots) {
      removedAny = (await attempt('container', name, 0, engine.removeStoppedContainer(name))) || removedAny;
    }
    for (const name of oldTools) {
      removedAny = (await attempt('tools', name, sizeOf(name), engine.removeOne('volume', name))) || removedAny;
    }
    if (imageState) {
      removedAny = (await attempt('image', image, imageState.bytes, engine.removeOne('image', image))) || removedAny;
    }
    for (const state of retired) {
      removedAny = (await attempt('image', state.name, state.bytes, engine.removeOne('image', state.name))) || removedAny;
    }
    return { freedBytes, kept, machine: removedAny ? await trimMachine() : { state: 'skipped' } };
  };

  return { read, cleanUp };
}
