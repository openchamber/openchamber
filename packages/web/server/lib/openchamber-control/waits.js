import { z } from 'zod';

import { OpenChamberControlError } from './error.js';

const EXTENSION_WAIT_ID_PREFIX = 'wait_';

const sourceSchema = z.string().trim();
const waitIdSchema = z.string().trim().min(1);
const jsonTextSchema = z.string().transform((text, context) => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
});
const prWaitArgsSchema = z.object({ url: z.unknown() });

const readPrWaitUrl = (input) => {
  const text = jsonTextSchema.safeParse(input.args);
  const args = prWaitArgsSchema.safeParse(text.success ? text.data : input.args);
  return (args.success ? args.data.url : undefined) ?? input.url;
};

const readWaitId = (input) => {
  const waitId = waitIdSchema.safeParse(input.waitId);
  if (waitId.success) return waitId.data;
  const url = waitIdSchema.safeParse(input.url);
  return url.success ? url.data : undefined;
};

export const runWaitAction = async ({ action, input, sessionID, extensionWaits, prWatch, resolveDirectory }) => {
  const prSource = prWatch?.waitSource() ?? null;

  if (action === 'wait.list') {
    const listed = await extensionWaits.listWaits(sessionID);
    if (!prSource) return listed;
    const [timer, ...extensions] = listed.sources;
    return {
      waiting: [...await prWatch.listWaits(sessionID), ...listed.waiting],
      sources: [timer, prSource, ...extensions].filter(Boolean),
    };
  }

  if (action === 'wait.stop') {
    const waitId = readWaitId(input);
    if (!prSource) return extensionWaits.stopWaits(sessionID, waitId);
    if (waitId && !waitId.startsWith(EXTENSION_WAIT_ID_PREFIX)) {
      await extensionWaits.load();
      const others = extensionWaits.snapshot().waits.filter((wait) => wait.sessionID === sessionID);
      const { stopped } = await prWatch.unwatch(sessionID, waitId);
      if (!stopped) throw new OpenChamberControlError(`This session has no wait ${waitId}; wait.list names its waits`, 404);
      return { waiting: [...await prWatch.listWaits(sessionID), ...others], stopped: 1 };
    }
    const pulls = await prWatch.listWaits(sessionID);
    const result = await extensionWaits.stopWaits(sessionID, waitId);
    if (waitId) return { waiting: [...pulls, ...result.waiting], stopped: result.stopped };
    try {
      await prWatch.unwatch(sessionID);
    } catch (error) {
      throw new OpenChamberControlError(`Stopped ${result.stopped} timer and extension waits, but the pull request waits go on: ${error?.message ?? error}`, 500);
    }
    return { waiting: result.waiting, stopped: pulls.length + result.stopped };
  }

  const directory = await resolveDirectory();
  const source = sourceSchema.safeParse(input.source);
  if (prSource && source.success && source.data === prSource.source) {
    return prWatch.watch({ sessionID, directory, url: readPrWaitUrl(input) });
  }
  return extensionWaits.startWait({ sessionID, directory, source: input.source, args: input.args });
};
