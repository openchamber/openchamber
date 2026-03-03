import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import type { OpenCodeManager, ConnectionStatus } from './opencode';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openchamber.chatView';

  private _view?: vscode.WebviewView;

  public isVisible() {
    return this._view?.visible ?? false;
  }

  // Cache latest status/URL for when webview is resolved after connection is ready
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _sseCounter = 0;
  private _sseStreams = new Map<string, AbortController>();
  private _sseHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeManager?: OpenCodeManager
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._view = webviewView;

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    // Send theme payload (including optional Shiki theme JSON) after the webview is set up.
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    
    // Send cached connection status and API URL (may have been set before webview was resolved)
    this._sendCachedState();

    webviewView.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (message.type === 'restartApi') {
        await this._openCodeManager?.restart();
        return;
      }

      if (message.type === 'api:sse:start') {
        const response = await this._startSseProxy(message);
        webviewView.webview.postMessage(response);
        return;
      }

      if (message.type === 'api:sse:stop') {
        const response = await this._stopSseProxy(message);
        webviewView.webview.postMessage(response);
        return;
      }

      const response = await handleBridgeMessage(message, {
        manager: this._openCodeManager,
        context: this._context,
      });
      webviewView.webview.postMessage(response);
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._view) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._view?.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      });
    }
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    // Cache the latest state
    this._cachedStatus = status;
    this._cachedError = error;
    
    // Send to webview if it exists
    this._sendCachedState();
  }

  public addTextToInput(text: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'addToContext',
        payload: { text }
      });
    }
  }

  public createNewSessionWithPrompt(prompt: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'createSessionWithPrompt',
        payload: { prompt }
      });
    }
  }

  public createNewSession() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'newSession'
      });
    }
  }

  public showSettings() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'showSettings'
      });
    }
  }

  public postMessage(message: unknown): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _sendCachedState() {
    if (!this._view) {
      return;
    }
    
    this._view.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
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

  private async _startSseProxy(message: BridgeRequest): Promise<BridgeResponse> {
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
      const message = error instanceof Error ? error.message : String(error);
      return {
        id,
        type,
        success: true,
        data: { status: 502, headers: { 'content-type': 'application/json' }, streamId: null, error: message },
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

    this._sseStreams.set(streamId, controller);

    const fallbackDirectory = this._openCodeManager?.getWorkingDirectory()
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || 'global';

    if (shouldInjectActivity) {
      const heartbeatTimer = setInterval(() => {
        if (controller.signal.aborted) {
          return;
        }
        const heartbeatChunk = `${buildHeartbeatEventBlock()}\n\n`;
        this._view?.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: heartbeatChunk });
      }, 30000);
      this._sseHeartbeats.set(streamId, heartbeatTimer);
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

              // Reduce webview message pressure by forwarding complete SSE blocks.
              // The SDK SSE parser is block-based (\n\n delimited) and can consume
              // partial chunks, but VS Code's postMessage channel can be a bottleneck.
              sseBuffer += chunk.replace(/\r\n/g, '\n');
              const blocks = sseBuffer.split('\n\n');
              sseBuffer = blocks.pop() ?? '';
              if (blocks.length > 0) {
                const routedBlocks = wrapAsGlobal
                  ? wrapSseBlocksAsGlobal(blocks, fallbackDirectory)
                  : blocks;
                const outboundBlocks = shouldInjectActivity ? expandSseBlocksWithActivity(routedBlocks) : routedBlocks;
                const joined = outboundBlocks.map((block: string) => `${block}\n\n`).join('');
                this._view?.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: joined });
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
              this._view?.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: joined });
            } else {
              this._view?.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: sseBuffer });
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }

        this._view?.webview.postMessage({ type: 'api:sse:end', streamId });
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          this._view?.webview.postMessage({ type: 'api:sse:end', streamId, error: message });
        }
      } finally {
        this._sseStreams.delete(streamId);
        const heartbeat = this._sseHeartbeats.get(streamId);
        if (heartbeat) {
          clearInterval(heartbeat);
          this._sseHeartbeats.delete(streamId);
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

  private async _stopSseProxy(message: BridgeRequest): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const { streamId } = (payload || {}) as { streamId?: string };
    if (typeof streamId === 'string' && streamId.length > 0) {
      const controller = this._sseStreams.get(streamId);
      if (controller) {
        controller.abort();
        this._sseStreams.delete(streamId);
      }

      const heartbeat = this._sseHeartbeats.get(streamId);
      if (heartbeat) {
        clearInterval(heartbeat);
        this._sseHeartbeats.delete(streamId);
      }
    }
    return { id, type, success: true, data: { stopped: true } };
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    // Use cached values which are updated by onStatusChange callback
    const initialStatus = this._cachedStatus;
    const cliAvailable = this._openCodeManager?.isCliAvailable() ?? false;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      cliAvailable,
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
  }

  if (type === 'message.updated') {
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId;
    const role = info?.role;
    const finish = info?.finish;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'message.part.updated' || type === 'message.part.delta') {
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId;
    const role = info?.role;
    const finish = info?.finish;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'session.idle') {
    const sessionId = properties?.sessionID ?? properties?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'idle' };
    }
  }

  return null;
};

const buildActivityEventBlock = (activity: SessionActivity): string => {
  return `data: ${JSON.stringify({
    type: 'openchamber:session-activity',
    properties: {
      sessionId: activity.sessionId,
      phase: activity.phase,
    },
  })}`;
};

const buildHeartbeatEventBlock = (): string => {
  return `data: ${JSON.stringify({ type: 'openchamber:heartbeat', timestamp: Date.now() })}`;
};

const parseSseBlockForGlobalWrap = (block: string): { id?: string; payload: Record<string, unknown> } | null => {
  if (!block) {
    return null;
  }

  const lines = block.split('\n');
  const dataLines: string[] = [];
  let eventId: string | undefined;

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
      continue;
    }
    if (line.startsWith('id:')) {
      const candidate = line.slice(3).trim();
      if (candidate) {
        eventId = candidate;
      }
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const nestedPayload = record.payload;
    const payload = nestedPayload && typeof nestedPayload === 'object'
      ? (nestedPayload as Record<string, unknown>)
      : record;

    return eventId ? { id: eventId, payload } : { payload };
  } catch {
    return null;
  }
};

const wrapSseBlocksAsGlobal = (blocks: string[], directory: string): string[] => {
  const normalizedDirectory = typeof directory === 'string' && directory.trim().length > 0
    ? directory.trim().replace(/\\/g, '/')
    : 'global';

  return blocks.map((block) => {
    const parsed = parseSseBlockForGlobalWrap(block);
    if (!parsed) {
      return block;
    }

    const envelope = {
      directory: normalizedDirectory,
      payload: parsed.payload,
    };

    const idPrefix = parsed.id ? `id: ${parsed.id}\n` : '';
    return `${idPrefix}data: ${JSON.stringify(envelope)}`;
  });
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
