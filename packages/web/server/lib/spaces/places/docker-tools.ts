
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
import type { ToolsSource } from '../tools.js';
import { CHANGE_TIMEOUT_MS, ROLLBACK_SETTLE_MS, entryLabels, entryName, failureField, isInterrupted } from './docker-engine.js';
import type { DockerEngine, DockerRemovalFailure } from './docker-engine.js';

const FILL_TIMEOUT_MS = 30 * 60_000;
const FILL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ERROR_TAIL_CHARACTERS = 2_000;

export interface DockerToolsOptions {
  engine: DockerEngine;
  owner: string;
  toolsSource: ToolsSource;
  image: string;
  now: () => Date;
  wait: (milliseconds: number) => Promise<void>;
}

export function createDockerTools({ engine, owner, toolsSource, image, now, wait }: DockerToolsOptions) {
  const source = requireToolsSource(toolsSource);
  const key = toolsContentKey(source, image);
  const volume = toolsResourceName(owner, key);
  let inFlight: Promise<string> | null = null;
  let filling = false;
  const fillListeners = new Set<() => void>();

  const labelsFor = (role: string) => labelArgs(buildToolsLabels({ role, owner, key, description: source.description, created: now().toISOString() }));
  const oneShotArgs = (role: string) => ({ containerName: toolsResourceName(owner, key, role), labelArguments: labelsFor(role), toolsVolume: volume, image });

  const findOurs = async (kind: 'container' | 'volume', filter: { key?: string; role?: string }) => (await engine.findByLabel(kind, toolsLabelFilterArgs({ owner, ...filter })))
    .filter((entry) => parseToolsLabels(entryLabels(kind, entry))?.owner === owner)
    .map(entryName);

  const removeOneShots = async () => {
    const failed: DockerRemovalFailure[] = [];
    for (const name of await findOurs('container', { key })) {
      const problem = await engine.removeOne('container', name);
      if (problem) failed.push(problem);
    }
    return failed;
  };

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

  const cleanUpFill = async (): Promise<DockerRemovalFailure[]> => {
    try {
      return [...(await removeOneShots()), ...(await engine.removeByName([['volume', volume]]))];
    } catch (error) {
      return [{ kind: 'volume', name: volume, message: failureField(error, 'message') }];
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
      const uncertain = isInterrupted(error);
      if (uncertain) {
        await wait(ROLLBACK_SETTLE_MS);
        rollbackFailures = await cleanUpFill();
      }
      const leftovers = rollbackFailures.length > 0
        ? ` Clean-up also failed for: ${rollbackFailures.map((item) => `${item.kind} ${item.name}`).join(', ')}.`
        : '';
      const wrapped = new SpaceError(failureField(error, 'code') ?? 'tools_fill_failed', `Could not prepare the tools for spaces. ${failureField(error, 'message')}${leftovers}`, { rollbackFailures, uncertain });
      wrapped.cause = error;
      throw wrapped;
    }
  };

  const prune = async () => {
    try {
      for (const name of await findOurs('volume', { role: ROLE_TOOLS })) {
        if (name !== volume) await engine.removeOne('volume', name);
      }
    } catch {
      return;
    }
  };

  const ensureOnce = async () => {
    const existing = await engine.inspect('volume', volume);
    const labels = parseToolsLabels(existing?.Labels);
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
    filling = true;
    for (const listener of fillListeners) listener();
    await fill();
    await prune();
    return volume;
  };

  const ensure = ({ onFill }: { onFill?: () => void } = {}) => {
    if (onFill) {
      if (filling) onFill();
      else fillListeners.add(onFill);
    }
    inFlight ??= ensureOnce().finally(() => {
      inFlight = null;
      filling = false;
      fillListeners.clear();
    });
    return inFlight;
  };

  const removeIfUnlabelled = async (name: string): Promise<DockerRemovalFailure[]> => {
    try {
      const entry = await engine.inspect('volume', name);
      const unlabelled = entry && Object.keys(entry.Labels ?? {}).length === 0;
      const problem = unlabelled ? await engine.removeOne('volume', name) : null;
      return problem ? [problem] : [];
    } catch (error) {
      return [{ kind: 'volume', name, message: failureField(error, 'message') }];
    }
  };

  const listOurs = async () => ({
    current: volume,
    volumes: await findOurs('volume', { role: ROLE_TOOLS }),
    oneShots: [...(await findOurs('container', { role: ROLE_TOOLS_FILL })), ...(await findOurs('container', { role: ROLE_TOOLS_CHECK }))],
  });

  return { ensure, prune, removeIfUnlabelled, listOurs };
}
