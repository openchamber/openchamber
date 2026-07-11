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
        normalizePwaOrientation,
      });

      app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      return;
    }

    // API-only mode: no frontend dist/ present
    console.log(`Running in API-only mode (no frontend dist/ found at ${distPath})`);
  };

  const registerApiOnlyFallbackRoutes = (app) => {
    app.get(/^(?!\/api|\/auth|\/health|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (req, res) => {
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
    <svg class="logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OpenChamber logo">
      <path d="M50 50 L8.432 26 L8.432 74 L50 98 Z" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M8.432 26 L18.824 32 L18.824 44 L8.432 38 Z" fill="currentColor" fill-opacity=".2"/>
      <path d="M18.824 32 L29.216 38 L29.216 50 L18.824 44 Z" fill="currentColor" fill-opacity=".45"/>
      <path d="M29.216 38 L39.608 44 L39.608 56 L29.216 50 Z" fill="currentColor" fill-opacity=".15"/>
      <path d="M39.608 44 L50 50 L50 62 L39.608 56 Z" fill="currentColor" fill-opacity=".55"/>
      <path d="M8.432 38 L18.824 44 L18.824 56 L8.432 50 Z" fill="currentColor" fill-opacity=".35"/>
      <path d="M18.824 44 L29.216 50 L29.216 62 L18.824 56 Z" fill="currentColor" fill-opacity=".1"/>
      <path d="M29.216 50 L39.608 56 L39.608 68 L29.216 62 Z" fill="currentColor" fill-opacity=".5"/>
      <path d="M39.608 56 L50 62 L50 74 L39.608 68 Z" fill="currentColor" fill-opacity=".25"/>
      <path d="M8.432 50 L18.824 56 L18.824 68 L8.432 62 Z" fill="currentColor" fill-opacity=".4"/>
      <path d="M18.824 56 L29.216 62 L29.216 74 L18.824 68 Z" fill="currentColor" fill-opacity=".3"/>
      <path d="M29.216 62 L39.608 68 L39.608 80 L29.216 74 Z" fill="currentColor" fill-opacity=".45"/>
      <path d="M39.608 68 L50 74 L50 86 L39.608 80 Z" fill="currentColor" fill-opacity=".15"/>
      <path d="M8.432 62 L18.824 68 L18.824 80 L8.432 74 Z" fill="currentColor" fill-opacity=".55"/>
      <path d="M18.824 68 L29.216 74 L29.216 86 L18.824 80 Z" fill="currentColor" fill-opacity=".2"/>
      <path d="M29.216 74 L39.608 80 L39.608 92 L29.216 86 Z" fill="currentColor" fill-opacity=".35"/>
      <path d="M39.608 80 L50 86 L50 98 L39.608 92 Z" fill="currentColor" fill-opacity=".1"/>
      <path d="M50 50 L91.568 26 L91.568 74 L50 98 Z" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M50 50 L60.392 44 L60.392 56 L50 62 Z" fill="currentColor" fill-opacity=".3"/>
      <path d="M60.392 44 L70.784 38 L70.784 50 L60.392 56 Z" fill="currentColor" fill-opacity=".15"/>
      <path d="M70.784 38 L81.176 32 L81.176 44 L70.784 50 Z" fill="currentColor" fill-opacity=".45"/>
      <path d="M81.176 32 L91.568 26 L91.568 38 L81.176 44 Z" fill="currentColor" fill-opacity=".25"/>
      <path d="M50 62 L60.392 56 L60.392 68 L50 74 Z" fill="currentColor" fill-opacity=".5"/>
      <path d="M60.392 56 L70.784 50 L70.784 62 L60.392 68 Z" fill="currentColor" fill-opacity=".35"/>
      <path d="M70.784 50 L81.176 44 L81.176 56 L70.784 62 Z" fill="currentColor" fill-opacity=".1"/>
      <path d="M81.176 44 L91.568 38 L91.568 50 L81.176 56 Z" fill="currentColor" fill-opacity=".4"/>
      <path d="M50 74 L60.392 68 L60.392 80 L50 86 Z" fill="currentColor" fill-opacity=".2"/>
      <path d="M60.392 68 L70.784 62 L70.784 74 L60.392 80 Z" fill="currentColor" fill-opacity=".55"/>
      <path d="M70.784 62 L81.176 56 L81.176 68 L70.784 74 Z" fill="currentColor" fill-opacity=".3"/>
      <path d="M81.176 56 L91.568 50 L91.568 62 L81.176 68 Z" fill="currentColor" fill-opacity=".15"/>
      <path d="M50 86 L60.392 80 L60.392 92 L50 98 Z" fill="currentColor" fill-opacity=".45"/>
      <path d="M60.392 80 L70.784 74 L70.784 86 L60.392 92 Z" fill="currentColor" fill-opacity=".25"/>
      <path d="M70.784 74 L81.176 68 L81.176 80 L70.784 86 Z" fill="currentColor" fill-opacity=".4"/>
      <path d="M81.176 68 L91.568 62 L91.568 74 L81.176 80 Z" fill="currentColor" fill-opacity=".2"/>
      <path d="M50 2 L8.432 26 L50 50 L91.568 26 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <g transform="matrix(.866 .5 -.866 .5 50 26) scale(.75)">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M-16 -20 L16 -20 L16 20 L-16 20 Z M-8 -12 L-8 12 L8 12 L8 -12 Z" fill="currentColor"/>
        <path d="M-8 -4 L8 -4 L8 12 L-8 12 Z" fill="currentColor" fill-opacity=".4"/>
      </g>
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
