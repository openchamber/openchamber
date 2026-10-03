// The disk that spaces take on the Docker place, and the clean-up of what OpenChamber can make
// again by itself (DESIGN.md, journey step 9 and decision 12): this owner's tools volumes but the
// current one, this owner's leftover one-shot containers, and the space image.
//
// Nothing here decides whether a resource is still needed. Every removal goes without force, and
// Docker refuses a volume a container mounts, an image a container was made from, and a running
// container. That refusal is the guard: whatever it keeps is in use, and stays.

import { SpaceError } from '../errors.js';
import { labelFilterArgs, parseSpaceLabels, ROLE_VOLUME } from '../labels.js';

const QUERY_TIMEOUT_MS = 60_000;
// `fstrim` inside the Colima machine took about a second on a 40 GiB disk.
const TRIM_TIMEOUT_MS = 120_000;
// Docker prints sizes with decimal units: `units.HumanSizeWithPrecision`, three digits.
const SIZE_UNITS = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };
// A removal Docker refused because something uses the resource, as the engine words it.
const IN_USE = /\bis in use\b|\bbeing used by\b|\bmust be forced\b|\bcontainer is running\b/i;
// Colima names its Docker machine `colima`, or `colima-<profile>` for another profile.
const COLIMA_MACHINE = /^colima(?:-([A-Za-z0-9._-]+))?$/;

/** Bytes from a size as `docker system df` prints it; anything else, `N/A` among it, counts as 0. */
export const parseDockerSize = (text) => {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|PB)$/.exec(String(text ?? '').trim());
  return match ? Math.round(Number(match[1]) * SIZE_UNITS[match[2]]) : 0;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new SpaceError('docker_output_unreadable', 'Docker printed something that is not JSON');
  }
};

/**
 * `engine` is the place's docker CLI, `tools` its tools volume with `listOurs`, `image` the pinned
 * space image. `colimaPath` is the colima CLI, or null: after a clean-up that removed anything, a
 * Docker machine that calls itself Colima is asked to hand the freed blocks back to the Mac.
 */
export function createDockerDisk({ engine, runCommand, colimaPath, owner, image, tools }) {
  /**
   * Docker's own account of the disk: every volume with its size and how many containers mount it,
   * by name, and what each image alone takes, by id. `docker image inspect` is no use for the
   * size: with the containerd image store it reports the compressed download, 400 MB for an image
   * that takes 1.63 GB unpacked.
   */
  const readUsage = async () => {
    const usage = parseJson(await engine.docker(['system', 'df', '--verbose', '--format', '{{json .}}'], QUERY_TIMEOUT_MS)) ?? {};
    return {
      volumes: new Map((usage.Volumes ?? []).map((volume) => [String(volume.Name), { bytes: parseDockerSize(volume.Size), links: Number.parseInt(volume.Links, 10) || 0 }])),
      images: new Map((usage.Images ?? []).map((entry) => [String(entry.ID), parseDockerSize(entry.UniqueSize)])),
    };
  };

  /** This owner's space volumes, found by label and checked again on the inspect result. */
  const spaceVolumes = async () => (await engine.findByLabel('volume', labelFilterArgs({ owner })))
    .filter((entry) => {
      const labels = parseSpaceLabels(entry.Labels);
      return labels?.owner === owner && labels.role === ROLE_VOLUME;
    })
    .map((entry) => String(entry.Name));

  /**
   * The image with what it alone takes, or null when it is not there. In use when any container
   * was made from it.
   */
  const readImage = async (images) => {
    const entry = await engine.inspect('image', image);
    if (!entry) return null;
    const users = await engine.docker(['ps', '--all', '--filter', `ancestor=${image}`, '--format', '{{.Names}}'], QUERY_TIMEOUT_MS);
    return { bytes: images.get(String(entry.Id)) ?? 0, inUse: users.trim() !== '' };
  };

  const measure = async () => {
    const [usage, ours, spaces] = await Promise.all([readUsage(), tools.listOurs(), spaceVolumes()]);
    const { volumes } = usage;
    const sizeOf = (name) => volumes.get(name)?.bytes ?? 0;
    const oldTools = ours.volumes.filter((name) => name !== ours.current);
    return { volumes, ours, oldTools, spaces, image: await readImage(usage.images), sizeOf };
  };

  /**
   * What the page shows: the image, the tools and the spaces' own volumes in bytes, and what a
   * clean-up would free now. `freesImage` says whether the image is part of that.
   */
  const read = async () => {
    const { volumes, ours, oldTools, spaces, image: imageState, sizeOf } = await measure();
    const freeTools = oldTools.filter((name) => (volumes.get(name)?.links ?? 0) === 0);
    const freesImage = imageState !== null && !imageState.inUse;
    const sum = (names) => names.reduce((total, name) => total + sizeOf(name), 0);
    return {
      imageBytes: imageState?.bytes ?? null,
      toolsBytes: sum(ours.volumes),
      spacesBytes: sum(spaces),
      freeBytes: sum(freeTools) + (freesImage ? imageState.bytes : 0),
      freesImage,
    };
  };

  /**
   * Asks Colima to trim its machine's disks, which is what gives freed space back to the Mac.
   * Never fails the clean-up: any other engine, a missing CLI, a stopped machine or a `sudo` that
   * wants a password ends here with the reason, for the log.
   */
  const trimMachine = async () => {
    if (!colimaPath) return { state: 'skipped' };
    try {
      const info = await engine.run(['info', '--format', '{{json .Name}}'], QUERY_TIMEOUT_MS);
      const match = info.code === 0 ? COLIMA_MACHINE.exec(String(parseJson(info.stdout))) : null;
      if (!match) return { state: 'skipped' };
      const result = await runCommand(colimaPath, ['ssh', '--profile', match[1] ?? 'default', '--', 'sudo', '-n', 'fstrim', '--all'], { timeoutMs: TRIM_TIMEOUT_MS });
      return result.code === 0 ? { state: 'trimmed' } : { state: 'failed', message: result.stderr.trim().slice(-500) || `exit code ${result.code}` };
    } catch (error) {
      return { state: 'failed', message: error?.message ?? String(error) };
    }
  };

  /**
   * Removes what OpenChamber can make again, each without force, and says what Docker kept.
   * `freedBytes` counts the sizes measured just before, of what is gone afterwards.
   */
  const cleanUp = async () => {
    const { oldTools, ours, image: imageState, sizeOf } = await measure();
    let freedBytes = 0;
    const kept = [];
    const attempt = async (kind, name, bytes, removal) => {
      const problem = await removal;
      if (!problem) {
        freedBytes += bytes;
        return true;
      }
      kept.push({ kind, name, reason: IN_USE.test(problem.message) ? 'in_use' : 'failed', message: problem.message });
      return false;
    };
    let removedAny = false;
    // Containers first: a one-shot left behind can hold a tools volume.
    for (const name of ours.oneShots) {
      removedAny = (await attempt('container', name, 0, engine.removeStoppedContainer(name))) || removedAny;
    }
    for (const name of oldTools) {
      removedAny = (await attempt('tools', name, sizeOf(name), engine.removeOne('volume', name))) || removedAny;
    }
    if (imageState) {
      removedAny = (await attempt('image', image, imageState.bytes, engine.removeOne('image', image))) || removedAny;
    }
    return { freedBytes, kept, machine: removedAny ? await trimMachine() : { state: 'skipped' } };
  };

  return { read, cleanUp };
}
