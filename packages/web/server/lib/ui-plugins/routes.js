// Declarative UI-plugin manifests this build ships. Data only: a manifest names
// a contribution point and the guest package (`id`) that fills it. Add an entry
// here to publish one; nothing else about a plugin travels through this route.
const BUILT_IN_UI_PLUGINS = Object.freeze([]);

export const getBuiltInUIPluginCatalog = () => [...BUILT_IN_UI_PLUGINS];

export const registerUIPluginRoutes = (app) => {
  app.get('/api/ui-plugins/catalog', (_req, res) => {
    res.json({ schemaVersion: 1, plugins: getBuiltInUIPluginCatalog() });
  });
};
