import { parse as parseJsonc } from 'jsonc-parser';
import { pathToFileURL } from 'node:url';

const PROVIDER_PROMPT_BOUNDARY = 'You are powered by the model named';
const MINIMAL_IDENTITY = 'You are OpenCode, a coding agent.';

const createPluginSource = () => String.raw`
const PROVIDER_PROMPT_BOUNDARY = ${JSON.stringify(PROVIDER_PROMPT_BOUNDARY)}
const MINIMAL_IDENTITY = ${JSON.stringify(MINIMAL_IDENTITY)}
const optimizedSessions = new Map()

export const OpenChamberSystemPromptPlugin = async () => ({
  "chat.message": async (input, output) => {
    if (!input.sessionID) return
    const agent = output?.message?.agent ?? input.agent
    if (agent === "build" || agent === "plan") {
      optimizedSessions.set(input.sessionID, agent)
      return
    }
    optimizedSessions.delete(input.sessionID)
  },
  event: async ({ event }) => {
    if (event?.type === "session.deleted") optimizedSessions.delete(event.properties?.info?.id)
  },
  "experimental.chat.system.transform": async (input, output) => {
    if (!input.sessionID || !optimizedSessions.has(input.sessionID)) return
    const prompt = output.system.join("\n")
    const boundary = prompt.indexOf(PROVIDER_PROMPT_BOUNDARY)
    if (boundary < 0) return
    output.system.length = 0
    output.system.push(MINIMAL_IDENTITY + "\n\n" + prompt.slice(boundary))
  },
})
`;

const mergePluginConfig = (rawConfig, pluginUrl) => {
  const errors = [];
  const parsed = typeof rawConfig === 'string' && rawConfig.trim()
    ? parseJsonc(rawConfig, errors, { allowTrailingComma: true })
    : {};
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OPENCODE_CONFIG_CONTENT must contain a valid JSON object before OpenChamber can inject its system prompt optimizer');
  }
  if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) {
    throw new Error('OPENCODE_CONFIG_CONTENT plugin must be an array before OpenChamber can inject its system prompt optimizer');
  }
  const configured = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  parsed.plugin = [
    ...configured.filter((value) => value !== pluginUrl && (!Array.isArray(value) || value[0] !== pluginUrl)),
    pluginUrl,
  ];
  return JSON.stringify(parsed);
};

export const createSystemPromptRuntime = ({ fsPromises, path, dataDir }) => {
  const pluginDirectory = path.join(dataDir, 'system-prompt');
  const pluginPath = path.join(pluginDirectory, 'openchamber-system-prompt-plugin.js');

  const prepareManagedOpenCodeEnv = async (rawConfig) => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginPath, createPluginSource(), { mode: 0o600 });
    return {
      OPENCODE_CONFIG_CONTENT: mergePluginConfig(rawConfig, pathToFileURL(pluginPath).href),
    };
  };

  return { prepareManagedOpenCodeEnv };
};
