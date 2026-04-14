import { registerAssetlinksRoute } from './assetlinks-routes.js';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';

export const createStaticRoutesRuntime = (dependencies) => {
  const {
    fs,
    path,
    process,
    __dirname,
    express,
    resolveProjectDirectory,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readSettingsFromDiskMigrated,
    normalizePwaAppName,
  } = dependencies;

  const resolveDistPath = () => {
    const env = typeof process.env.OPENCHAMBER_DIST_DIR === 'string' ? process.env.OPENCHAMBER_DIST_DIR.trim() : '';
    if (env) {
      return path.resolve(env);
    }
    return path.join(__dirname, '..', 'dist');
  };

  const registerStaticRoutes = (app) => {
    const distPath = resolveDistPath();

    // Register assetlinks route outside the dist-path check so it works in dev mode too
    registerAssetlinksRoute(app, { process });

    if (fs.existsSync(distPath)) {
      console.log(`Serving static files from ${distPath}`);
      app.use(express.static(distPath, {
        setHeaders(res, filePath) {
          // Service workers should never be long-cached; iOS is especially sensitive.
          if (typeof filePath === 'string' && filePath.endsWith(`${path.sep}sw.js`)) {
            res.setHeader('Cache-Control', 'no-store');
          }
        },
      }));

      registerPwaManifestRoute(app, {
        process,
        resolveProjectDirectory,
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        readSettingsFromDiskMigrated,
        normalizePwaAppName,
      });

      app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      return;
    }

    console.warn(`Warning: ${distPath} not found, static files will not be served`);
    app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
      res.status(404).send('Static files not found. Please build the application first.');
    });
  };

  return {
    registerStaticRoutes,
  };
};
