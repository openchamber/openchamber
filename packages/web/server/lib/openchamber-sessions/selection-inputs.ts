import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { parseModelSelection } from '../opencode/config-v2.js';
import { controlErrorFields } from '../openchamber-control/error.js';
import { LOCATION_PLUGINS_NOT_READY, waitForLocationPlugins } from '../opencode/location-plugins.js';
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
  let notReadyReason: string | null = await waitForLocationPlugins(client, AbortSignal.timeout(10_000)) ? null : LOCATION_PLUGINS_NOT_READY;
  const options = { signal: AbortSignal.timeout(10_000) };
  const [models, agents, configEntries] = await Promise.all([
    // external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/location.ts OpenCode before 2.4 waits for plugins itself and refuses with 503 when they take too long.
    client.model.list(undefined, options).then((response) => asList(response?.data)).catch((cause: unknown) => {
      notReadyReason ??= pluginActivationFailure(cause);
      return [];
    }),
    client.agent.list(undefined, options).then((response) => asList(response?.data)).catch(() => null),
    client.config.get(undefined, options).then((response) => asList(response)).catch(() => null),
  ]);
  if (configEntries === null) return { settings, models, agents, config: null, notReadyReason };

  const config: SelectionConfig = { defaultAgent: null, defaultModel: null };
  for (const entry of configEntries) {
    const info = isRecord(entry) && 'info' in entry ? entry.info : undefined;
    if (!info) continue;
    const agent = asNonEmptyString(info.default_agent);
    if (agent) config.defaultAgent = agent;
    const model = parseModelSelection(info.model);
    if (model) config.defaultModel = model;
  }

  return { settings, models, agents, config, notReadyReason };
};
