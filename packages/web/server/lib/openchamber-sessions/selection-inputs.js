import { asNonEmptyString } from '../shared/guards.js';
import { parseModelSelection } from '../opencode/config-v2.js';

const asList = (value) => (Array.isArray(value) ? value : []);

/**
 * One snapshot for this directory. Unknown catalogues can validate an explicit
 * choice permissively, but cannot establish the defaults for a new session.
 */
export const fetchSelectionInputs = async ({ client, readSettingsFromDiskMigrated }) => {
  const settings = await readSettingsFromDiskMigrated();
  const options = { signal: AbortSignal.timeout(10_000) };
  const [models, agents, configEntries] = await Promise.all([
    client.model.list(undefined, options).then((response) => asList(response?.data)).catch(() => []),
    // v2 agents carry `id` (`build`, what prompts and sessions refer to) and a
    // display `name` (`Build`); every lookup here is by id.
    client.agent.list(undefined, options).then((response) => asList(response?.data)).catch(() => null),
    client.config.get(undefined, options).then((response) => asList(response)).catch(() => null),
  ]);
  if (configEntries === null) return { settings, models, agents, config: null };

  // Config entries arrive lowest priority first, so the last definition wins.
  const config = { defaultAgent: null, defaultModel: null };
  for (const entry of configEntries) {
    const info = entry?.info;
    if (!info) continue;
    const agent = asNonEmptyString(info.default_agent);
    if (agent) config.defaultAgent = agent;
    // Config `model` is the v2 selection spelling: "provider/model#variant" or
    // the expanded object form. The canonical parser folds both.
    const model = parseModelSelection(info.model);
    if (model) config.defaultModel = model;
  }

  return { settings, models, agents, config };
};

const isReady = (inputs) => inputs.agents?.length > 0 && inputs.config !== null;

/**
 * A new worktree's OpenCode location answers its first agent read empty and
 * fills the list about a second later, so a create right after the worktree
 * reads again until the agents and config arrive or `deadlineMs` passes.
 * Past the deadline the last read stands, and the caller refuses as before.
 */
export const fetchWarmSelectionInputs = async (read, { deadlineMs = 15_000, pauseMs = 500, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) => {
  const deadline = now() + deadlineMs;
  let inputs = await read();
  while (!isReady(inputs) && now() < deadline) {
    await sleep(pauseMs);
    inputs = await read();
  }
  return inputs;
};
