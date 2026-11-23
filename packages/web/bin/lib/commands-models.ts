import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestControlAction } from './cli-control.js';
import { isJsonMode, printJson } from '../cli-output.js';
import type { CliOptions } from './cli-args.js';
import { asNonEmptyString } from '../../server/lib/shared/object-guards.js';

type ModelRefInput = {
  providerID?: unknown;
  providerId?: unknown;
  modelID?: unknown;
  modelId?: unknown;
  id?: unknown;
};

export type ModelSettingsInput = {
  defaultModel?: unknown;
  defaultAgent?: unknown;
  defaultVariant?: unknown;
  favoriteModels?: unknown;
  recentModels?: unknown;
};

const formatModelRef = (entry: ModelRefInput | null | undefined) => {
  const providerID = asNonEmptyString(entry?.providerID) || asNonEmptyString(entry?.providerId);
  const modelID = asNonEmptyString(entry?.modelID) || asNonEmptyString(entry?.modelId) || asNonEmptyString(entry?.id);
  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const formatDefaultLine = ({ defaultModel, defaultAgent, defaultVariant }: ModelSettingsInput) => {
  const model = asNonEmptyString(defaultModel) || 'none';
  const agent = asNonEmptyString(defaultAgent) || 'none';
  const variant = asNonEmptyString(defaultVariant);
  return `Default: \`${model}${variant ? ` (${variant})` : ''}\` / \`${agent}\``;
};

const formatModelsOutput = (settings: ModelSettingsInput = {}) => {
  const favorites = Array.isArray(settings.favoriteModels)
    ? settings.favoriteModels.map(formatModelRef).filter(Boolean)
    : [];
  const recent = Array.isArray(settings.recentModels)
    ? settings.recentModels.map(formatModelRef).filter(Boolean)
    : [];
  const lines = [
    formatDefaultLine(settings),
    '',
    'Favorites:',
    ...(favorites.length > 0 ? favorites.map((model) => `- \`${model}\``) : ['- none']),
    '',
    'Recent:',
    ...(recent.length > 0 ? recent.map((model) => `- \`${model}\``) : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
};

async function modelsCommand(options: Partial<CliOptions> = {}, action = 'show') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Models Commands\n\nUSAGE:\n  openchamber models [OPTIONS]\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n`);
    return;
  }
  if (action !== 'show') {
    throw new TunnelCliError(`Unknown models command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const port = await resolveTargetPort(options);
  const result = await requestControlAction(port, 'models.list', {}, options);

  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  process.stdout.write(formatModelsOutput(result));
}

export { modelsCommand, formatModelsOutput };
