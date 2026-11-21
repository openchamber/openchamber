import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { parseModelSelection } from '../opencode/config-v2.js';
import { controlErrorFields } from '../openchamber-control/error.js';
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

const pluginActivationFailure = (cause: unknown) => {
  const fields = controlErrorFields(cause);
  return fields?._tag === 'ServiceUnavailableError' && Object(cause).service === 'plugin' ? asNonEmptyString(fields.message) : null;
};

export const fetchSelectionInputs = async <Settings>({ client, readSettingsFromDiskMigrated }: SelectionInputDependencies<Settings>) => {
  const settings = await readSettingsFromDiskMigrated();
  const requestDeadline = () => ({ signal: AbortSignal.timeout(10_000) });
  let notReadyReason: string | null = null;
  const modelsAfterPluginActivation = await client.model.list(undefined, requestDeadline()).then((response) => asList(response?.data)).catch((cause: unknown) => {
    notReadyReason = pluginActivationFailure(cause);
    return [];
  });
  const options = requestDeadline();
  const [agents, configEntries] = await Promise.all([
    client.agent.list(undefined, options).then((response) => asList(response?.data)).catch(() => null),
    client.config.get(undefined, options).then((response) => asList(response)).catch(() => null),
  ]);
  if (configEntries === null) return { settings, models: modelsAfterPluginActivation, agents, config: null, notReadyReason };

  const config: SelectionConfig = { defaultAgent: null, defaultModel: null };
  for (const entry of configEntries) {
    const info = isRecord(entry) && 'info' in entry ? entry.info : undefined;
    if (!info) continue;
    const agent = asNonEmptyString(info.default_agent);
    if (agent) config.defaultAgent = agent;
    const model = parseModelSelection(info.model);
    if (model) config.defaultModel = model;
  }

  return { settings, models: modelsAfterPluginActivation, agents, config, notReadyReason };
};
