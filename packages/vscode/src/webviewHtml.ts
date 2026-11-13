import * as vscode from 'vscode';
import * as os from 'os';
import { getThemeKindName } from './theme';
import type { ConnectionStatus } from './opencode';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  workspaceFolder: string;
  workspaceFolders?: WorkspaceFolderCandidate[];
  initialStatus: ConnectionStatus;
  cliAvailable: boolean;
  initialSessionId?: string;
  /** A new-session editor tab that opens its draft in "Run on several models" mode. */
  initialComposer?: 'parallel';
  viewMode?: 'sidebar' | 'editor';
  panelType?: 'chat' | 'settings';
  devServerUrl?: string | null;
  extensionVersion?: string;
}

const asCspToken = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toOrigin = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const uniqueTokens = (values: Array<string | null | undefined>): string => {
  return Array.from(new Set(values.map(asCspToken).filter((value): value is string => Boolean(value)))).join(' ');
};

export const getCspBootstrapHtml = (): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
</head>
<body></body>
</html>`;

export function getWebviewHtml(options: WebviewHtmlOptions): string {
  const {
    webview,
    extensionUri,
    workspaceFolder,
    workspaceFolders = [],
    initialStatus,
    cliAvailable,
    initialSessionId,
    initialComposer,
    viewMode = 'sidebar',
    panelType = 'chat',
    devServerUrl,
    extensionVersion = '',
  } = options;
  const workspaceFolderJson = JSON.stringify(workspaceFolder).replace(/</g, '\\u003c');
  const workspaceFoldersJson = JSON.stringify(workspaceFolders).replace(/</g, '\\u003c');

  const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js');
  const scriptUri = webview.asWebviewUri(scriptPath);
  const normalizedDevServerUrl = asCspToken(devServerUrl)?.replace(/\/$/, '') ?? null;
  const devServerOrigin = toOrigin(normalizedDevServerUrl);
  const styleSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", devServerOrigin]);
  const scriptSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", "'unsafe-eval'", devServerOrigin]);
  const connectSrc = uniqueTokens(['*', 'ws:', 'wss:', 'http:', 'https:', devServerOrigin]);
  const imgSrc = uniqueTokens([webview.cspSource, 'data:', 'https:', devServerOrigin]);
  const fontSrc = uniqueTokens([webview.cspSource, 'data:', devServerOrigin]);
  // fflate's async browser inflater creates blob-backed workers. Keep blob:
  // scoped to worker-src so document decompression works without allowing blob scripts.
  const workerSrc = uniqueTokens([webview.cspSource, 'blob:', devServerOrigin]);

  const themeKind = getThemeKindName(vscode.window.activeColorTheme.kind);

  // Use VS Code CSS variables for proper theme integration
  // These variables are automatically provided by VS Code to webviews
  //
  // The logo markup between the brand:flat-logo markers is written by
  // scripts/brand/generate.mjs, the same drawing as OpenChamberLogo.tsx.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; connect-src ${connectSrc}; img-src ${imgSrc}; media-src ${imgSrc}; font-src ${fontSrc}; worker-src ${workerSrc};">
  <style>
    html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; }
    body { 
      overflow: hidden; 
      background: var(--vscode-editor-background, var(--vscode-sideBar-background)); 
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      color: var(--vscode-foreground);
    }
    
    /* Initial loading screen styles - uses VS Code theme variables */
    #initial-loading {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      z-index: 9999;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      transition: opacity 0.3s ease-out;
    }
    #initial-loading.fade-out {
      opacity: 0;
      pointer-events: none;
    }
    /* The logo is drawn in currentColor: the VS Code foreground. */
    #initial-loading .logo {
      color: var(--vscode-foreground);
    }
    #initial-loading .status-text {
      font-size: 13px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      text-align: center;
    }
    #initial-loading .error-text {
      font-size: 12px;
      color: var(--vscode-errorForeground, #f48771);
      text-align: center;
      max-width: 280px;
    }
  </style>
  <title>OpenChamber</title>
</head>
<body>
  <!-- Initial loading screen with the OpenChamber logo -->
  <div id="initial-loading">
    <svg class="logo" width="70" height="70" viewBox="-50 -50 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- brand:flat-logo:start --><defs><linearGradient id="oc-logo-l" gradientUnits="userSpaceOnUse" x1="-42" y1="-20" x2="-2" y2="12"><stop offset="0" stop-color="currentColor" stop-opacity="0.025"/><stop offset="0.72" stop-color="currentColor" stop-opacity="0.143"/><stop offset="1" stop-color="currentColor" stop-opacity="0.198"/></linearGradient><linearGradient id="oc-logo-r" gradientUnits="userSpaceOnUse" x1="40" y1="3" x2="3" y2="-16"><stop offset="0" stop-color="currentColor" stop-opacity="0.071"/><stop offset="0.68" stop-color="currentColor" stop-opacity="0.174"/><stop offset="1" stop-color="currentColor" stop-opacity="0.223"/></linearGradient></defs><path d="M-41.568 -24 L-41.568 24 L0 0 Z" fill="url(#oc-logo-l)"/><path d="M41.568 -24 L0 0 L41.568 24 Z" fill="url(#oc-logo-r)"/><path d="M0 -48 L41.568 -24 L0 0 L-41.568 -24 Z" fill="currentColor" fill-opacity="0.08"/><path data-tier="0" data-rest="0.12" data-lit="0.55" d="M0 -43.2 L33.254 -24 L0 -4.8 L-33.254 -24 Z" fill="currentColor" fill-opacity="0.22"/><path data-tier="1" data-rest="0.15" data-lit="0.48" d="M0 -37.92 L24.109 -24 L0 -10.08 L-24.109 -24 Z" fill="currentColor" fill-opacity="0.27"/><path data-tier="2" data-rest="0.38" data-lit="0.85" d="M0 -32.64 L14.964 -24 L0 -15.36 L-14.964 -24 Z" fill="currentColor" fill-opacity="0.85"/><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M0 -48 L-41.568 -24 L0 0 L41.568 -24 Z"/><path d="M-41.568 -24 L-41.568 24 L0 48 L41.568 24 L41.568 -24"/><path d="M0 0 L0 48"/></g><!-- brand:flat-logo:end -->
    </svg>
    <!-- Status text stays empty while things are fine; populated only on error. -->
    <div class="status-text" id="loading-status"></div>
    ${!cliAvailable ? `<div class="error-text" id="cli-missing-text">OpenCode CLI not found. Please install it first.</div>` : ''}
  </div>
  
  <div id="root"></div>
  <script>
    // While the splash shows, the roof tiers light up one at a time, one step a
    // second, like the app's own startup logo; a smooth CSS animation repainted
    // the logo on every frame.
    (function () {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      var step = 0;
      var timer = null;
      var tick = function () {
        var splash = document.getElementById('initial-loading');
        var tiers = splash ? splash.querySelectorAll('[data-tier]') : [];
        if (!tiers.length || splash.classList.contains('fade-out')) { clearInterval(timer); return; }
        var lit = step % tiers.length;
        tiers.forEach(function (tier, i) {
          tier.setAttribute('fill-opacity', tier.getAttribute(i === lit ? 'data-lit' : 'data-rest'));
        });
        step += 1;
      };
      tick();
      timer = setInterval(tick, 1000);
    })();

    // Polyfill process for Node.js modules running in browser
    window.process = window.process || { env: { NODE_ENV: 'production' }, platform: '', version: '', browser: true };

    window.__VSCODE_CONFIG__ = {
      workspaceFolder: ${workspaceFolderJson},
      workspaceFolders: ${workspaceFoldersJson},
      theme: "${themeKind}",
      connectionStatus: "${initialStatus}",
      cliAvailable: ${cliAvailable},
      extensionVersion: "${extensionVersion.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",
      platform: "${os.platform()}",
      arch: "${os.arch()}",
      viewMode: "${viewMode}",
      panelType: "${panelType}",
      initialSessionId: ${initialSessionId ? `"${initialSessionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'null'},
      initialComposer: ${initialComposer ? `"${initialComposer}"` : 'null'},
    };
    window.__OPENCHAMBER_HOME__ = ${workspaceFolderJson};
    // VS Code's display language. The UI bundle uses it as the default locale
    // until the user picks one; the splash below picks its strings from it too.
    window.__OPENCHAMBER_HOST_LANGUAGE__ = ${JSON.stringify(vscode.env.language)};

    // OpenChamber's own saved locale wins; before one exists, VS Code's display
    // language decides, so a fresh install in a supported language never boots
    // in English.
    function resolveBootstrapLanguage() {
      try {
        var rawLocale = window.localStorage.getItem('openchamber.i18n.v1');
        if (rawLocale) {
          var parsedLocale = JSON.parse(rawLocale);
          if (parsedLocale && typeof parsedLocale.locale === 'string') return parsedLocale.locale.toLowerCase();
        }
      } catch {}
      return String(window.__OPENCHAMBER_HOST_LANGUAGE__ || '').toLowerCase();
    }

    function getBootstrapMessages() {
      var locale = 'en';
      var detected = resolveBootstrapLanguage();
      if (detected.indexOf('fr') === 0) {
        locale = 'fr';
      } else if (detected.indexOf('tr') === 0) {
        locale = 'tr';
      }

      if (locale === 'fr') {
        return {
          startingApi: 'Démarrage de l’API OpenCode…',
          initializing: 'Initialisation…',
          connecting: 'Connexion…',
          connected: 'Connecté !',
          connectionError: 'Erreur de connexion',
          reconnecting: 'Reconnexion…',
          cliNotFound: 'L’interface en ligne de commande OpenCode est introuvable. Veuillez l’installer d’abord.',
        };
      }
      if (locale === 'tr') {
        return {
          startingApi: 'OpenCode API başlatılıyor…',
          initializing: 'Başlatılıyor…',
          connecting: 'Bağlanıyor…',
          connected: 'Bağlandı!',
          connectionError: 'Bağlantı hatası',
          reconnecting: 'Yeniden bağlanıyor…',
          cliNotFound: 'OpenCode CLI bulunamadı. Lütfen önce kurun.',
        };
      }
      return {
        startingApi: 'Starting OpenCode API…',
        initializing: 'Initializing…',
        connecting: 'Connecting…',
        connected: 'Connected!',
        connectionError: 'Connection error',
        reconnecting: 'Reconnecting…',
        cliNotFound: 'OpenCode CLI not found. Please install it first.',
      };
    }

    (function applyBootstrapLocale() {
      var statusEl = document.getElementById('loading-status');
      var cliMissingEl = document.getElementById('cli-missing-text');
      var messages = getBootstrapMessages();
      if (cliMissingEl) {
        cliMissingEl.textContent = messages.cliNotFound;
      }
      if (statusEl) {
        statusEl.textContent = '';
      }
    })();

    // Handle connection status updates to update loading screen
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'connectionStatus') {
        var messages = getBootstrapMessages();
        var statusEl = document.getElementById('loading-status');
        if (statusEl) {
          // Only show text when something is wrong — progress states stay silent
          // (the animated logo already signals "working").
          if (msg.status === 'error') {
            statusEl.textContent = msg.error || messages.connectionError;
            statusEl.classList.add('error-text');
          } else {
            statusEl.textContent = '';
            statusEl.classList.remove('error-text');
          }
        }
      }
    });
  </script>
  <script type="module">
    const prodEntryUrl = ${JSON.stringify(scriptUri.toString())};
    const devServerUrl = ${normalizedDevServerUrl ? JSON.stringify(normalizedDevServerUrl) : 'null'};

    const loadProductionBundle = () => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = prodEntryUrl;
      document.body.appendChild(script);
    };

    if (!devServerUrl) {
      loadProductionBundle();
    } else {
      const baseUrl = devServerUrl;

      const statusEl = document.getElementById('loading-status');
      const getDevMessages = () => {
        const detected = resolveBootstrapLanguage();
        if (detected.indexOf('fr') === 0) {
          return {
            startingDevServer: (host) => 'Démarrage du serveur de développement de la webview (' + host + ')...',
            waitingDevServer: (host, attempt) => 'En attente du serveur de développement de la webview (' + host + ')... tentative ' + attempt,
          };
        }
        if (detected.indexOf('tr') === 0) {
          return {
            startingDevServer: (host) => 'Webview dev sunucusu başlatılıyor (' + host + ')...',
            waitingDevServer: (host, attempt) => 'Webview dev sunucusu bekleniyor (' + host + ')... deneme ' + attempt,
          };
        }
        return {
          startingDevServer: (host) => 'Starting webview dev server (' + host + ')...',
          waitingDevServer: (host, attempt) => 'Waiting for webview dev server (' + host + ')... attempt ' + attempt,
        };
      };
      const setStatus = (text) => {
        if (statusEl) {
          statusEl.textContent = text;
        }
      };

      const retryDelayMs = 500;
      let attempt = 0;

      const waitForRootMount = (timeoutMs) => {
        const root = document.getElementById('root');
        if (!root) {
          return Promise.resolve(false);
        }

        if (root.childNodes.length > 0) {
          return Promise.resolve(true);
        }

        return new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (root.childNodes.length > 0) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(true);
            }
          });

          observer.observe(root, { childList: true, subtree: true });
          const timer = window.setTimeout(() => {
            observer.disconnect();
            resolve(root.childNodes.length > 0);
          }, timeoutMs);
        });
      };

      const tryLoadDevBundle = () => {
        const viteClientUrl = baseUrl + '/@vite/client';
        const reactRefreshUrl = baseUrl + '/@react-refresh';
        const devEntryUrl = baseUrl + '/main.tsx';
        const hostLabel = (() => {
          try {
            return new URL(baseUrl).host;
          } catch {
            return baseUrl;
          }
        })();

        const devMessages = getDevMessages();
        setStatus(devMessages.startingDevServer(hostLabel));

        Promise.resolve()
          .then(() => import(viteClientUrl))
          .then(() => import(reactRefreshUrl))
          .then((mod) => {
            const runtime = mod && mod.default ? mod.default : null;
            if (runtime && typeof runtime.injectIntoGlobalHook === 'function') {
              runtime.injectIntoGlobalHook(window);
              window.$RefreshReg$ = () => {};
              window.$RefreshSig$ = () => (type) => type;
              window.__vite_plugin_react_preamble_installed__ = true;
            }
          })
          .then(() => import(devEntryUrl))
          .then(() => waitForRootMount(4000))
          .then((mounted) => {
            if (!mounted) {
              throw new Error('Dev bundle loaded but app did not mount');
            }
          })
          .catch((error) => {
            attempt += 1;
            console.warn('[OpenChamber] VS Code webview dev bundle unavailable, retrying...', error);
            setStatus(devMessages.waitingDevServer(hostLabel, attempt));
            window.setTimeout(() => {
              tryLoadDevBundle();
            }, retryDelayMs);
          });
      };

      tryLoadDevBundle();
    }
  </script>
</body>
</html>`;
}
