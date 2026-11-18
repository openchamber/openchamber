import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { parseModelSelection } from '../opencode/config-v2.js';
import type { OpenCodeClient } from '@opencode/client';

const asList = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);

interface SelectionInputDependencies<Settings> {
  client: OpenCodeClient;
  readSettingsFromDiskMigrated: () => Promise<Settings>;
}

interface SelectionConfig {
  defaultAgent: string | null;
  defaultModel: ReturnType<typeof parseModelSelection>;
}

export const fetchSelectionInputs = async <Settings>({ client, readSettingsFromDiskMigrated }: SelectionInputDependencies<Settings>) => {
  const settings = await readSettingsFromDiskMigrated();
  const options = { signal: AbortSignal.timeout(10_000) };
  const [models, agents, configEntries] = await Promise.all([
    client.model.list(undefined, options).then((response) => asList(response?.data)).catch(() => []),
    client.agent.list(undefined, options).then((response) => asList(response?.data)).catch(() => null),
    client.config.get(undefined, options).then((response) => asList(response)).catch(() => null),
  ]);
  if (configEntries === null) return { settings, models, agents, config: null };

  const config: SelectionConfig = { defaultAgent: null, defaultModel: null };
  for (const entry of configEntries) {
    const info = isRecord(entry) && 'info' in entry ? entry.info : undefined;
    if (!info) continue;
    const agent = asNonEmptyString(info.default_agent);
    if (agent) config.defaultAgent = agent;
    const model = parseModelSelection(info.model);
    if (model) config.defaultModel = model;
  }

  return { settings, models, agents, config };
};

const isReady = (inputs: { agents: unknown[] | null; config: object | null }) => (inputs.agents?.length ?? 0) > 0 && inputs.config !== null;

export interface SelectionWarmUpOptions {
  deadlineMs?: number;
  pauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const fetchWarmSelectionInputs = async <T extends { agents: unknown[] | null; config: object | null }>(read: () => Promise<T>, { deadlineMs = 15_000, pauseMs = 500, now = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }: SelectionWarmUpOptions = {}) => {
  const deadline = now() + deadlineMs;
  let inputs = await read();
  while (!isReady(inputs) && now() < deadline) {
    await sleep(pauseMs);
    inputs = await read();
  }
  return inputs;
};
