import { pathToFileURL } from 'node:url';
import { appendManagedPlugin } from '../opencode/managed-plugin-config.js';

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

export const createSystemPromptRuntime = ({ fsPromises, path, dataDir }) => {
  const pluginDirectory = path.join(dataDir, 'system-prompt');
  const pluginPath = path.join(pluginDirectory, 'openchamber-system-prompt-plugin.js');

  const prepareManagedOpenCodeEnv = async (rawConfig) => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginPath, createPluginSource(), { mode: 0o600 });
    return {
      OPENCODE_CONFIG_CONTENT: appendManagedPlugin(rawConfig, pathToFileURL(pluginPath).href, 'system prompt optimizer'),
    };
  };

  return { prepareManagedOpenCodeEnv };
};
