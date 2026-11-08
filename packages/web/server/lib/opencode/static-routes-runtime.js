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
    normalizePwaOrientation,
    isRequestAuthorized,
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

    if (fs.existsSync(distPath)) {
      console.log(`Serving static files from ${distPath}`);
      const hashedAssetsPrefix = path.join(distPath, 'assets') + path.sep;
      app.use(express.static(distPath, {
        setHeaders(res, filePath) {
          // Service workers should never be long-cached; iOS is especially sensitive.
          if (filePath.endsWith(`${path.sep}sw.js`)) {
            res.setHeader('Cache-Control', 'no-store');
            return;
          }
          // Vite names every file under assets/ by its content hash, so a name
          // never changes meaning. Without this each lazy chunk costs a
          // revalidation round trip, which is felt on remote connections.
          if (filePath.startsWith(hashedAssetsPrefix)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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
        normalizePwaOrientation,
        isRequestAuthorized,
      });

      app.get(/^(?!\/api|\/linear|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      return;
    }

    console.warn(`Warning: ${distPath} not found, static files will not be served`);
    app.get(/^(?!\/api|\/linear|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
      res.status(404).send('Static files not found. Please build the application first.');
    });
  };

  const registerApiOnlyFallbackRoutes = (app) => {
    app.get(/^(?!\/api|\/auth|\/health|\/linear|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (req, res) => {
      const command = 'openchamber connect-url --help';
      res.status(200).format({
        html: () => {
          res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenChamber API-only mode</title>
  <style>
    :root {
      color-scheme: dark;
      --surface-background: #151313;
      --surface-elevated: #1c1b1a;
      --surface-foreground: #cdccc3;
      --surface-muted-foreground: #b6b4ab;
      --interactive-border: rgba(57,56,54,.72);
      --primary-base: #edb449;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --surface-background: oklch(0.97 0.02 85);
        --surface-elevated: oklch(0.99 0.01 90);
        --surface-foreground: oklch(0.25 0.02 40);
        --surface-muted-foreground: oklch(0.45 0.02 50);
        --interactive-border: rgba(194,151,77,.22);
        --primary-base: oklch(0.65 0.2 55);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
      background: var(--surface-background);
      color: var(--surface-foreground);
      padding: 32px;
    }
    main {
      width: min(448px, 100%);
      text-align: center;
    }
    .logo {
      width: 86px;
      height: 86px;
      margin: 0 auto 28px;
      display: block;
      color: var(--surface-foreground);
      opacity: .88;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      font-weight: 600;
      letter-spacing: -.025em;
    }
    p {
      margin: 10px auto 0;
      max-width: 400px;
      color: var(--surface-muted-foreground);
      font-size: 14px;
      line-height: 1.6;
    }
    .command {
      margin: 24px auto 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      max-width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--interactive-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface-background) 60%, transparent);
      backdrop-filter: blur(8px);
    }
    code {
      color: var(--surface-foreground);
      font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: nowrap;
      overflow-x: auto;
      text-align: left;
    }
    button {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--surface-muted-foreground);
      cursor: pointer;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px;
      transition: color .15s ease;
    }
    button:hover { color: var(--surface-foreground); }
    button svg { width: 16px; height: 16px; display: block; }
    .check-icon { display: none; }
    button[data-copied="true"] .copy-icon { display: none; }
    button[data-copied="true"] .check-icon { display: block; color: var(--primary-base); }
  </style>
</head>
<body>
  <main>
    <svg class="logo" viewBox="-50 -50 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OpenChamber logo">
      <!-- brand:flat-logo:start --><defs><linearGradient id="oc-logo-l" gradientUnits="userSpaceOnUse" x1="-42" y1="-20" x2="-2" y2="12"><stop offset="0" stop-color="currentColor" stop-opacity="0.025"/><stop offset="0.72" stop-color="currentColor" stop-opacity="0.143"/><stop offset="1" stop-color="currentColor" stop-opacity="0.198"/></linearGradient><linearGradient id="oc-logo-r" gradientUnits="userSpaceOnUse" x1="40" y1="3" x2="3" y2="-16"><stop offset="0" stop-color="currentColor" stop-opacity="0.071"/><stop offset="0.68" stop-color="currentColor" stop-opacity="0.174"/><stop offset="1" stop-color="currentColor" stop-opacity="0.223"/></linearGradient></defs><path d="M-41.568 -24 L-41.568 24 L0 0 Z" fill="url(#oc-logo-l)"/><path d="M41.568 -24 L0 0 L41.568 24 Z" fill="url(#oc-logo-r)"/><path d="M0 -48 L41.568 -24 L0 0 L-41.568 -24 Z" fill="currentColor" fill-opacity="0.08"/><path data-tier="0" data-rest="0.12" data-lit="0.55" d="M0 -43.2 L33.254 -24 L0 -4.8 L-33.254 -24 Z" fill="currentColor" fill-opacity="0.22"/><path data-tier="1" data-rest="0.15" data-lit="0.48" d="M0 -37.92 L24.109 -24 L0 -10.08 L-24.109 -24 Z" fill="currentColor" fill-opacity="0.27"/><path data-tier="2" data-rest="0.38" data-lit="0.85" d="M0 -32.64 L14.964 -24 L0 -15.36 L-14.964 -24 Z" fill="currentColor" fill-opacity="0.85"/><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M0 -48 L-41.568 -24 L0 0 L41.568 -24 Z"/><path d="M-41.568 -24 L-41.568 24 L0 48 L41.568 24 L41.568 -24"/><path d="M0 0 L0 48"/></g><!-- brand:flat-logo:end -->
    </svg>
    <h1>OpenChamber is running in headless mode</h1>
    <p>This server is ready. Open it from the OpenChamber desktop or mobile app to use it.</p>
    <div class="command">
      <code id="connect-command">${command}</code>
      <button type="button" id="copy-command" aria-label="Copy command" title="Copy command">
        <svg class="copy-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 7.2C8 6.08 8 5.52 8.218 5.092a2 2 0 0 1 .874-.874C9.52 4 10.08 4 11.2 4h5.6c1.12 0 1.68 0 2.108.218a2 2 0 0 1 .874.874C20 5.52 20 6.08 20 7.2v5.6c0 1.12 0 1.68-.218 2.108a2 2 0 0 1-.874.874C18.48 16 17.92 16 16.8 16h-5.6c-1.12 0-1.68 0-2.108-.218a2 2 0 0 1-.874-.874C8 14.48 8 13.92 8 12.8V7.2Z" stroke="currentColor" stroke-width="1.8"/>
          <path d="M4 8v8.8C4 17.92 4 18.48 4.218 18.908a2 2 0 0 0 .874.874C5.52 20 6.08 20 7.2 20H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <svg class="check-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 12.5 9.5 17 19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </main>
  <script>
    const button = document.getElementById('copy-command');
    const command = document.getElementById('connect-command');
    let copyTimer;
    button?.addEventListener('click', async () => {
      const text = command?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        button.dataset.copied = 'true';
        window.clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => {
          button.dataset.copied = 'false';
        }, 1400);
      } catch {
        button.dataset.copied = 'false';
      }
    });
  </script>
</body>
</html>`);
        },
        json: () => {
          res.json({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
        },
        default: () => {
          res.type('text/plain').send('OpenChamber is running in API-only mode');
        },
      });
    });
  };

  return {
    registerApiOnlyFallbackRoutes,
    registerStaticRoutes,
  };
};
