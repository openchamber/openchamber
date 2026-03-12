import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  sseStreams: Map<string, AbortController>;
  sseHeartbeats: Map<string, ReturnType<typeof setInterval>>;
};

export class SessionEditorPanelProvider {
  public static readonly viewType = 'openchamber.sessionEditor';

  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _panels = new Map<string, SessionPanelState>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {}

  public createOrShowNewSession(): void {
    // Generate unique panel ID for new session drafts
    const panelId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this._createPanel(panelId, 'New Session', null);
  }

  public createOrShow(sessionId: string, title?: string): void {
    if (!sessionId || typeof sessionId !== 'string') {
      return;
    }

    const sessionTitle = title && title.trim().length > 0 ? title.trim() : 'Session';

    const existing = this._panels.get(sessionId);
    if (existing) {
      existing.panel.title = sessionTitle;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }

    this._createPanel(sessionId, sessionTitle, sessionId);
  }

  private _createPanel(panelId: string, title: string, initialSessionId: string | null): void {
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    const panel = vscode.window.createWebviewPanel(
      SessionEditorPanelProvider.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };

    const state: SessionPanelState = {
      panel,
      sseStreams: new Map(),
      sseHeartbeats: new Map(),
    };

    this._panels.set(panelId, state);

    panel.webview.html = this._getHtmlForWebview(panel.webview, initialSessionId);

    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedStateToPanel(state);

    panel.onDidDispose(() => {
      this._disposePanel(panelId);
    }, null, this._context.subscriptions);

    panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'api:sse:start') {
        const response = await this._startSseProxy(message, state);
        state.panel.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = await this._stopSseProxy(message, state);
        state.panel.webview.postMessage(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      state.panel.webview.postMessage(response);
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    const themeKind = getThemeKindName(kind);
    void getWebviewShikiThemes().then((shikiThemes) => {
      for (const entry of this._panels.values()) {
        entry.panel.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      }
    });
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cachedStatus = status;
    this._cachedError = error;

    for (const entry of this._panels.values()) {
      this._sendCachedStateToPanel(entry);
    }
  }

  private _sendCachedStateToPanel(entry: SessionPanelState) {
    entry.panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
  }

  private _disposePanel(sessionId: string) {
    const entry = this._panels.get(sessionId);
    if (!entry) return;

    for (const controller of entry.sseStreams.values()) {
      controller.abort();
    }
    entry.sseStreams.clear();

    for (const heartbeat of entry.sseHeartbeats.values()) {
      clearInterval(heartbeat);
    }
    entry.sseHeartbeats.clear();

    this._panels.delete(sessionId);
  }

  private _buildSseHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(extra || {}),
    };
  }

  private _collectHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  private async _startSseProxy(message: BridgeRequest, entry: SessionPanelState): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const apiBaseUrl = this._openCodeManager?.getApiUrl();

    const { path, headers } = (payload || {}) as { path?: string; headers?: Record<string, string> };
    const normalizedPath = typeof path === 'string' && path.trim().length > 0 ? path.trim() : '/event';
    const normalizedPathname = (() => {
      const rawPathname = normalizedPath.split('?')[0];
      if (rawPathname === '/') return '/';
      return rawPathname.replace(/\/+$/, '');
    })();
    const shouldInjectActivity = normalizedPathname === '/event' || normalizedPathname === '/global/event';

    if (!apiBaseUrl) {
      return {
        id,
        type,
        success: true,
        data: { status: 503, headers: { 'content-type': 'application/json' }, streamId: null },
      };
    }

    const streamId = `sse_${++this._sseCounter}_${Date.now()}`;
    const controller = new AbortController();

    const base = `${apiBaseUrl.replace(/\/+$/, '')}/`;
    const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();

    let response: Response;
    let wrapAsGlobal = false;

    const requestHeaders = this._buildSseHeaders({
      ...(headers || {}),
      ...(this._openCodeManager?.getOpenCodeAuthHeaders() || {}),
    });

    try {
      response = await fetch(targetUrl, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal,
      });

      // Fallback: OpenCode versions without /global/event.
      // VS Code is single-workspace, so we can wrap /event into { directory, payload }.
      if ((!response.ok || !response.body) && normalizedPathname === '/global/event') {
        const fallbackUrl = new URL('event', base).toString();
        response = await fetch(fallbackUrl, {
          method: 'GET',
          headers: requestHeaders,
          signal: controller.signal,
        });
        if (response.ok && response.body) {
          wrapAsGlobal = true;
        }
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return {
        id,
        type,
        success: true,
        data: { status: 502, headers: { 'content-type': 'application/json' }, streamId: null, error: messageText },
      };
    }

    const responseHeaders = this._collectHeaders(response.headers);
    const responseBody = response.body;
    if (!response.ok || !responseBody) {
      return {
        id,
        type,
        success: true,
        data: {
          status: response.status,
          headers: responseHeaders,
          streamId: null,
          error: `SSE failed: ${response.status}`,
        },
      };
    }

    entry.sseStreams.set(streamId, controller);

    const fallbackDirectory = this._openCodeManager?.getWorkingDirectory()
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || 'global';

    if (shouldInjectActivity) {
      const heartbeatTimer = setInterval(() => {
        if (controller.signal.aborted) {
          return;
        }
        const heartbeatChunk = `${buildHeartbeatEventBlock()}\n\n`;
        entry.panel.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: heartbeatChunk });
      }, 30000);
      entry.sseHeartbeats.set(streamId, heartbeatTimer);
    }

    (async () => {
      try {
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) break;
            if (value && value.length > 0) {
              const chunk = decoder.decode(value, { stream: true });
              if (!chunk) continue;

              sseBuffer += chunk.replace(/\r\n/g, '\n');
              const blocks = sseBuffer.split('\n\n');
              sseBuffer = blocks.pop() ?? '';
              if (blocks.length > 0) {
                const routedBlocks = wrapAsGlobal
                  ? wrapSseBlocksAsGlobal(blocks, fallbackDirectory)
                  : blocks;
                const outboundBlocks = shouldInjectActivity ? expandSseBlocksWithActivity(routedBlocks) : routedBlocks;
                const joined = outboundBlocks.map((block: string) => `${block}\n\n`).join('');
                entry.panel.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: joined });
              }
            }
          }

          const tail = decoder.decode();
          if (tail) {
            sseBuffer += tail.replace(/\r\n/g, '\n');
          }
          if (sseBuffer) {
            if (shouldInjectActivity) {
              const baseBlocks = wrapAsGlobal
                ? wrapSseBlocksAsGlobal([sseBuffer], fallbackDirectory)
                : [sseBuffer];
              const outboundBlocks = expandSseBlocksWithActivity(baseBlocks);
              const joined = outboundBlocks.map((block: string) => `${block}\n\n`).join('');
              entry.panel.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: joined });
            } else {
              entry.panel.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: sseBuffer });
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }

        entry.panel.webview.postMessage({ type: 'api:sse:end', streamId });
      } catch (error) {
        if (!controller.signal.aborted) {
          const messageText = error instanceof Error ? error.message : String(error);
          entry.panel.webview.postMessage({ type: 'api:sse:end', streamId, error: messageText });
        }
      } finally {
        entry.sseStreams.delete(streamId);
        const heartbeat = entry.sseHeartbeats.get(streamId);
        if (heartbeat) {
          clearInterval(heartbeat);
          entry.sseHeartbeats.delete(streamId);
        }
      }
    })();

    return {
      id,
      type,
      success: true,
      data: {
        status: response.status,
        headers: responseHeaders,
        streamId,
      },
    };
  }

  private async _stopSseProxy(message: BridgeRequest, entry: SessionPanelState): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const { streamId } = (payload || {}) as { streamId?: string };
    if (typeof streamId === 'string' && streamId.length > 0) {
      const controller = entry.sseStreams.get(streamId);
      if (controller) {
        controller.abort();
        entry.sseStreams.delete(streamId);
      }

      const heartbeat = entry.sseHeartbeats.get(streamId);
      if (heartbeat) {
        clearInterval(heartbeat);
        entry.sseHeartbeats.delete(streamId);
      }
    }
    return { id, type, success: true, data: { stopped: true } };
  }

  private _getHtmlForWebview(webview: vscode.Webview, sessionId: string | null) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const initialStatus = this._cachedStatus;
    const cliAvailable = this._openCodeManager?.isCliAvailable() ?? false;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      cliAvailable,
      panelType: 'chat',
      initialSessionId: sessionId ?? undefined,
      viewMode: 'editor',
    });
  }
}

type SessionActivityPhase = 'idle' | 'busy' | 'cooldown';

type SessionActivity = {
  sessionId: string;
  phase: SessionActivityPhase;
};

const parseSseDataPayload = (block: string): Record<string, unknown> | null => {
  if (!block) {
    return null;
  }

  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^\s/, ''));

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const nestedPayload = record.payload;
      if (nestedPayload && typeof nestedPayload === 'object') {
        return nestedPayload as Record<string, unknown>;
      }
      return record;
    }
    return null;
  } catch {
    return null;
  }
};

const deriveSessionActivity = (payload: Record<string, unknown> | null): SessionActivity | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const type = payload.type;
  const properties = payload.properties as Record<string, unknown> | undefined;

  if (type === 'session.status') {
    const status = properties?.status as Record<string, unknown> | undefined;
    const sessionId = properties?.sessionID ?? properties?.sessionId;
    const statusType = status?.type;

    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof statusType === 'string') {
      const phase: SessionActivityPhase = statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle';
      return { sessionId, phase };
    }

    return null;
  }

  if (type === 'message.updated') {
    const info = payload.info as Record<string, unknown> | undefined;
    const role = info?.role;
    const finish = info?.finish;
    const sessionId = info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId;

    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }

    return null;
  }

  if (type === 'message.complete') {
    const info = payload.info as Record<string, unknown> | undefined;
    const role = info?.role;
    const finish = info?.finish;
    const sessionId = info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId;

    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }

    return null;
  }

  if (type === 'session.idle') {
    const sessionId = properties?.sessionID ?? properties?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'idle' };
    }
    return null;
  }

  return null;
};

const buildActivityEventBlock = (activity: SessionActivity): string => {
  return [
    'event: message',
    `data: ${JSON.stringify({
      type: 'openchamber:session-activity',
      properties: {
        sessionId: activity.sessionId,
        phase: activity.phase,
        at: Date.now(),
      },
    })}`,
  ].join('\n');
};

const buildHeartbeatEventBlock = (): string => {
  return [
    'event: message',
    `data: ${JSON.stringify({
      type: 'openchamber:heartbeat',
      properties: {
        at: Date.now(),
      },
    })}`,
  ].join('\n');
};

const expandSseBlocksWithActivity = (blocks: string[]): string[] => {
  const expanded: string[] = [];

  for (const block of blocks) {
    expanded.push(block);

    const activity = deriveSessionActivity(parseSseDataPayload(block));
    if (activity) {
      expanded.push(buildActivityEventBlock(activity));
    }
  }

  return expanded;
};

const wrapSseBlocksAsGlobal = (blocks: string[], directory: string): string[] => {
  return blocks.map((block) => {
    const payload = parseSseDataPayload(block);
    const wrappedPayload = payload
      ? { directory, payload }
      : { directory, payload: null };

    const updatedLines = block
      .split('\n')
      .filter((line) => !line.startsWith('data:'));

    updatedLines.push(`data: ${JSON.stringify(wrappedPayload)}`);

    return updatedLines.join('\n');
  });
};
