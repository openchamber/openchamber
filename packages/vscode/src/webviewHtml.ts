import * as vscode from 'vscode';
import { getThemeKindName } from './theme';
import type { ConnectionStatus } from './opencode';
import { getVSCodeRuntimeCopy, resolveVSCodeLocale } from './i18n';

export type PanelType = 'chat' | 'agentManager';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  workspaceFolder: string;
  initialStatus: ConnectionStatus;
  cliAvailable: boolean;
  panelType?: PanelType;
  initialSessionId?: string;
  viewMode?: 'sidebar' | 'editor';
  devServerUrl?: string | null;
  locale?: string;
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

export function getWebviewHtml(options: WebviewHtmlOptions): string {
  const {
    webview,
    extensionUri,
    workspaceFolder,
    initialStatus,
    cliAvailable,
    panelType = 'chat',
    initialSessionId,
    viewMode = 'sidebar',
    devServerUrl,
    locale = 'en',
  } = options;

  const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js');
  const scriptUri = webview.asWebviewUri(scriptPath);
  const normalizedLocale = resolveVSCodeLocale(locale);
  const copy = getVSCodeRuntimeCopy(normalizedLocale).webview;
  const normalizedDevServerUrl = asCspToken(devServerUrl)?.replace(/\/$/, '') ?? null;
  const devServerOrigin = toOrigin(normalizedDevServerUrl);
  const styleSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", devServerOrigin]);
  const scriptSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", "'unsafe-eval'", devServerOrigin]);
  const connectSrc = uniqueTokens(['*', 'ws:', 'wss:', 'http:', 'https:', devServerOrigin]);
  const imgSrc = uniqueTokens([webview.cspSource, 'data:', 'https:', devServerOrigin]);
  const fontSrc = uniqueTokens([webview.cspSource, 'data:', devServerOrigin]);

  const themeKind = getThemeKindName(vscode.window.activeColorTheme.kind);

  // Use VS Code CSS variables for proper theme integration
  // These variables are automatically provided by VS Code to webviews
  // 
  // Logo geometry matches OpenChamberLogo.tsx:
  // edge=48, cos30=0.866, sin30=0.5, centerY=50
  // top=(50, 2), left=(8.432, 26), right=(91.568, 26), center=(50, 50)
  // bottomLeft=(8.432, 74), bottomRight=(91.568, 74), bottom=(50, 98)
  // topFaceCenterY = (2 + 26 + 50 + 26) / 4 = 26
  return `<!DOCTYPE html>
<html lang="${normalizedLocale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; connect-src ${connectSrc}; img-src ${imgSrc}; font-src ${fontSrc};">
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
    /* Logo colors use VS Code foreground color */
    #initial-loading .logo-stroke {
      stroke: var(--vscode-foreground);
    }
    #initial-loading .logo-fill {
      fill: var(--vscode-foreground);
      opacity: 0.15;
    }
    #initial-loading .logo-fill-solid {
      fill: var(--vscode-foreground);
    }
    #initial-loading .logo-fill-dim {
      fill: var(--vscode-foreground);
      opacity: 0.4;
    }
    /* Animation on inner logo only, like OpenChamberLogo.tsx */
    #initial-loading .logo-inner {
      animation: logoPulse 3s ease-in-out infinite;
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
    @keyframes logoPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
  </style>
  <title>OpenChamber</title>
</head>
<body>
  <!-- Initial loading screen with simplified OpenChamber logo -->
  <div id="initial-loading">
    <svg class="logo" width="70" height="70" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- Left face -->
      <path class="logo-fill logo-stroke" d="M50 50 L8.432 26 L8.432 74 L50 98 Z" stroke-width="2" stroke-linejoin="round"/>
      <!-- Right face -->
      <path class="logo-fill logo-stroke" d="M50 50 L91.568 26 L91.568 74 L50 98 Z" stroke-width="2" stroke-linejoin="round"/>
      <!-- Top face (no fill, stroke only) -->
      <path class="logo-stroke" d="M50 2 L8.432 26 L50 50 L91.568 26 Z" fill="none" stroke-width="2" stroke-linejoin="round"/>
      
      <!-- OpenCode logo on top face with pulse animation -->
      <g class="logo-inner" transform="matrix(0.866, 0.5, -0.866, 0.5, 50, 26) scale(0.75)">
        <path class="logo-fill-solid" fill-rule="evenodd" clip-rule="evenodd" d="M-16 -20 L16 -20 L16 20 L-16 20 Z M-8 -12 L-8 12 L8 12 L8 -12 Z"/>
        <path class="logo-fill-dim" d="M-8 -4 L8 -4 L8 12 L-8 12 Z"/>
      </g>
    </svg>
    <div class="status-text" id="loading-status">
      ${initialStatus === 'connecting' ? copy.startingApi : initialStatus === 'connected' ? copy.initializing : copy.connecting}
    </div>
    ${!cliAvailable ? `<div class="error-text">${copy.cliMissing}</div>` : ''}
  </div>
  
  <div id="root"></div>
  <script>
    // Polyfill process for Node.js modules running in browser
    window.process = window.process || { env: { NODE_ENV: 'production' }, platform: '', version: '', browser: true };

    window.__VSCODE_CONFIG__ = {
      workspaceFolder: "${workspaceFolder.replace(/\\/g, '\\\\')}",
      theme: "${themeKind}",
      connectionStatus: "${initialStatus}",
      locale: ${JSON.stringify(locale)},
      cliAvailable: ${cliAvailable},
      panelType: "${panelType}",
      viewMode: "${viewMode}",
      initialSessionId: ${initialSessionId ? `"${initialSessionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'null'},
    };
    window.__OPENCHAMBER_HOME__ = "${workspaceFolder.replace(/\\/g, '\\\\')}";
    
    // Handle connection status updates to update loading screen
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'connectionStatus') {
        var statusEl = document.getElementById('loading-status');
        if (statusEl) {
          if (msg.status === 'connecting') {
            statusEl.textContent = ${JSON.stringify(copy.startingApi)};
            statusEl.classList.remove('error-text');
          } else if (msg.status === 'connected') {
            statusEl.textContent = ${JSON.stringify(copy.connected)};
            statusEl.classList.remove('error-text');
          } else if (msg.status === 'error') {
            statusEl.textContent = msg.error || ${JSON.stringify(copy.connectionError)};
            statusEl.classList.add('error-text');
          } else {
            statusEl.textContent = ${JSON.stringify(copy.reconnecting)};
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

        setStatus(${JSON.stringify(copy.startingDevServer('__HOST__'))}.replace('__HOST__', hostLabel));

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
            setStatus(${JSON.stringify(copy.waitingDevServer('__HOST__', 99999))}.replace('__HOST__', hostLabel).replace('99999', String(attempt)));
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
