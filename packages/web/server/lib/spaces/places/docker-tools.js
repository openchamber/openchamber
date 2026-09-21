// The tools volume of the Docker place: one volume per owner and per tools content,
// filled once by a one-shot container and mounted read-only into spaces.
// A filled volume is never changed again. New content means a new key and a new volume.

import { SpaceError } from '../errors.js';
import { TOOLS_MARKER_MISSING_EXIT_CODE, buildToolsCheckRunArgs, buildToolsFillRunArgs } from '../hardening.js';
import {
  ROLE_TOOLS,
  ROLE_TOOLS_CHECK,
  ROLE_TOOLS_FILL,
  buildToolsLabels,
  labelArgs,
  parseToolsLabels,
  toolsLabelFilterArgs,
  toolsResourceName,
} from '../labels.js';
import { buildFillInput } from '../tools-filler.js';
import { requireToolsSource, toolsContentKey } from '../tools.js';
import { CHANGE_TIMEOUT_MS, ROLLBACK_SETTLE_MS, entryLabels, entryName, isInterrupted } from './docker-engine.js';

// A fill downloads about 440 MB. It took 36 seconds here and may take many minutes on a slow link.
const FILL_TIMEOUT_MS = 30 * 60_000;
// npm prints one line per warning, and a broken install prints a long error report.
const FILL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ERROR_TAIL_CHARACTERS = 2_000;

export function createDockerTools({ engine, owner, toolsSource, image, now, wait }) {
  const source = requireToolsSource(toolsSource);
  const key = toolsContentKey(source, image);
  const volume = toolsResourceName(owner, key);
  let inFlight = null;

  const labelsFor = (role) => labelArgs(buildToolsLabels({ role, owner, key, description: source.description, created: now().toISOString() }));
  const oneShotArgs = (role) => ({ containerName: toolsResourceName(owner, key, role), labelArguments: labelsFor(role), toolsVolume: volume, image });

  /** This owner's tools resources of one kind, checked again on the inspect result. */
  const findOurs = async (kind, filter) => (await engine.findByLabel(kind, toolsLabelFilterArgs({ owner, ...filter })))
    .filter((entry) => parseToolsLabels(entryLabels(kind, entry))?.owner === owner)
    .map(entryName);

  /** One-shot containers of this key that a killed CLI left behind. They would block the container name. */
  const removeOneShots = async () => {
    const failed = [];
    for (const name of await findOurs('container', { key })) {
      const problem = await engine.removeOne('container', name);
      if (problem) failed.push(problem);
    }
    return failed;
  };

  /**
   * What the fill marker says: `filled`, `missing`, or `wrong` for a marker with other content.
   * A docker CLI that cannot reach the daemon exits with 1, as `cat` does for a missing file, so
   * "missing" has an exit code of its own. Every other failure rejects: it must never read as
   * "not filled", because that would remove a filled volume.
   */
  const readMarker = async () => {
    const args = buildToolsCheckRunArgs(oneShotArgs(ROLE_TOOLS_CHECK));
    const result = await engine.run(args, CHANGE_TIMEOUT_MS);
    if (result.code === TOOLS_MARKER_MISSING_EXIT_CODE) {
      return 'missing';
    }
    if (result.code !== 0) {
      throw engine.failure(args, result);
    }
    return result.stdout.trim() === key ? 'filled' : 'wrong';
  };

  /** Removes what a failed fill made. The volume goes by name: this call found the name free, or found it ours. */
  const cleanUpFill = async () => {
    try {
      return [...(await removeOneShots()), ...(await engine.removeByName([['volume', volume]]))];
    } catch (error) {
      return [{ kind: 'volume', name: volume, message: error.message }];
    }
  };

  const fill = async () => {
    try {
      await engine.docker(['volume', 'create', ...labelsFor(ROLE_TOOLS), volume], CHANGE_TIMEOUT_MS);
      const result = await engine.run(buildToolsFillRunArgs(oneShotArgs(ROLE_TOOLS_FILL)), FILL_TIMEOUT_MS, {
        stdin: buildFillInput({ key, packageJson: source.packageJson, files: source.files }),
        maxOutputBytes: FILL_MAX_OUTPUT_BYTES,
      });
      if (result.code !== 0) {
        throw new SpaceError(
          'tools_fill_failed',
          `Installing ${source.description} failed: ${result.stderr.trim().slice(-ERROR_TAIL_CHARACTERS) || `exit code ${result.code}`}. Common causes: the Docker machine cannot reach the npm registry, or this version was never published.`,
        );
      }
      if ((await readMarker()) !== 'filled') {
        throw new SpaceError('tools_fill_failed', `Installing ${source.description} ended without the fill marker, or the space user cannot read it.`);
      }
    } catch (error) {
      let rollbackFailures = await cleanUpFill();
      // The CLI was killed, the daemon may still run the filler. Sweep again after a pause.
      const uncertain = isInterrupted(error);
      if (uncertain) {
        await wait(ROLLBACK_SETTLE_MS);
        rollbackFailures = await cleanUpFill();
      }
      const leftovers = rollbackFailures.length > 0
        ? ` Clean-up also failed for: ${rollbackFailures.map((item) => `${item.kind} ${item.name}`).join(', ')}.`
        : '';
      const wrapped = new SpaceError(error.code ?? 'tools_fill_failed', `Could not prepare the tools for spaces. ${error.message}${leftovers}`, { rollbackFailures, uncertain });
      wrapped.cause = error;
      throw wrapped;
    }
  };

  /**
   * Removes this owner's other tools volumes. Docker refuses a volume that a container
   * still mounts, and that refusal means "a space still runs on it, keep it".
   * Nothing here may fail the call that asked for it.
   */
  const prune = async () => {
    try {
      for (const name of await findOurs('volume', { role: ROLE_TOOLS })) {
        if (name !== volume) await engine.removeOne('volume', name);
      }
    } catch {
      // The next fill or the next recreate tries again.
    }
  };

  const ensureOnce = async () => {
    const existing = await engine.inspect('volume', volume);
    const labels = parseToolsLabels(existing?.Labels);
    // `docker volume create` succeeds silently on an existing name, so a stranger's volume is never adopted.
    if (existing && (labels?.role !== ROLE_TOOLS || labels?.owner !== owner || labels?.key !== key)) {
      throw new SpaceError('tools_volume_not_ours', `Docker already has a volume named ${volume} that this OpenChamber installation did not create. Remove it, then try again.`);
    }
    const leftovers = await removeOneShots();
    if (leftovers.length > 0) {
      throw new SpaceError('tools_cleanup_failed', `Could not remove an old tools container: ${leftovers.map((item) => `${item.name} (${item.message})`).join(', ')}`);
    }
    if (existing) {
      const marker = await readMarker();
      if (marker === 'filled') {
        return volume;
      }
      // Ours by label. No marker means a fill was interrupted. A wrong or empty marker means the
      // Docker machine went down right after a fill, or something else wrote here. Either way the
      // content cannot be trusted, so start over. Docker refuses while any container mounts the volume.
      const problem = await engine.removeOne('volume', volume);
      if (problem && marker === 'wrong') {
        throw new SpaceError(
          'tools_marker_mismatch',
          `The tools for spaces are damaged and must be installed again, but spaces still use them. Apply or discard the work in the spaces that were made with ${source.description}, remove those spaces, then try again.`,
          { volume, reason: problem.message },
        );
      }
      if (problem) {
        throw new SpaceError('tools_volume_stuck', `The tools volume ${volume} was never filled to the end and could not be removed: ${problem.message}`);
      }
    }
    await fill();
    await prune();
    return volume;
  };

  /** Resolves the name of the filled tools volume. Concurrent calls share one run, so one key is never filled twice at once. */
  const ensure = () => {
    inFlight ??= ensureOnce().finally(() => { inFlight = null; });
    return inFlight;
  };

  /**
   * For the failure path of a create that got `name` back from `ensure` as ours and filled.
   * If another process pruned it in between, `docker create` made it again without labels, and
   * every later call would refuse it as a stranger's. A volume with no labels at all is that
   * leftover, and goes by name. A volume with labels, ours or anyone's, is never touched here.
   */
  const removeIfUnlabelled = async (name) => {
    try {
      const entry = await engine.inspect('volume', name);
      const unlabelled = entry && Object.keys(entry.Labels ?? {}).length === 0;
      const problem = unlabelled ? await engine.removeOne('volume', name) : null;
      return problem ? [problem] : [];
    } catch (error) {
      return [{ kind: 'volume', name, message: error.message }];
    }
  };

  return { ensure, prune, removeIfUnlabelled };
}
