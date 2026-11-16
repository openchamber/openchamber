import { asNonEmptyString } from '../shared/guards.js';
import { parseModelSelection } from '../opencode/config-v2.js';

const asList = (value) => (Array.isArray(value) ? value : []);

export const fetchSelectionInputs = async ({ client, readSettingsFromDiskMigrated }) => {
  const settings = await readSettingsFromDiskMigrated();
  const options = { signal: AbortSignal.timeout(10_000) };
  const [models, agents, configEntries] = await Promise.all([
    client.model.list(undefined, options).then((response) => asList(response?.data)).catch(() => []),
    client.agent.list(undefined, options).then((response) => asList(response?.data)).catch(() => null),
    client.config.get(undefined, options).then((response) => asList(response)).catch(() => null),
  ]);
  if (configEntries === null) return { settings, models, agents, config: null };

  const config = { defaultAgent: null, defaultModel: null };
  for (const entry of configEntries) {
    const info = entry?.info;
    if (!info) continue;
    const agent = asNonEmptyString(info.default_agent);
    if (agent) config.defaultAgent = agent;
    const model = parseModelSelection(info.model);
    if (model) config.defaultModel = model;
  }

  return { settings, models, agents, config };
};

const isReady = (inputs) => inputs.agents?.length > 0 && inputs.config !== null;

// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 A new worktree's initial agent list can be empty while its location starts.
export const fetchWarmSelectionInputs = async (read, { deadlineMs = 15_000, pauseMs = 500, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) => {
  const deadline = now() + deadlineMs;
  let inputs = await read();
  while (!isReady(inputs) && now() < deadline) {
    await sleep(pauseMs);
    inputs = await read();
  }
  return inputs;
};
