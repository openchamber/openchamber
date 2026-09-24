const PLUGIN_ID = 'openchamber-opencode-go-session';

// OpenCode 2.0.16 does not attribute its stateless generate path at the
// provider boundary. An HTTP header on /api/experimental/generate is not
// forwarded there, so a managed plugin fills only the missing provider header.
const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

const PLUGIN_SOURCE = `const SESSION_HEADER = "x-opencode-session"

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    const fallbackSessionID = globalThis.crypto.randomUUID()
    await ctx.provider.transform((providers) => {
      if (!providers.get("opencode-go")) return
      providers.update("opencode-go", (provider) => {
        const entries = Object.entries(provider.headers || {})
        let sessionID = ""
        const headers = {}
        for (const [name, value] of entries) {
          if (name.toLowerCase() === SESSION_HEADER) {
            if (String(value).trim()) sessionID = String(value)
            continue
          }
          headers[name] = value
        }
        provider.headers = { ...headers, [SESSION_HEADER]: sessionID || fallbackSessionID }
      })
    })
  },
}
`;

export const createOpenCodeGoSessionPluginRuntime = ({ fsPromises, path, dataDir }) => {
  const pluginDirectory = path.join(dataDir, 'provider-compat', PLUGIN_ID);

  const materializePlugin = async () => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(path.join(pluginDirectory, 'index.js'), PLUGIN_SOURCE, { mode: 0o600 });
    return pluginDirectory;
  };

  return { pluginDirectory, materializePlugin };
};
