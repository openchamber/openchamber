import React from 'react';
import { Button } from '@/components/ui/button';
import { useMcpStore } from '@/stores/useMcpStore';
import { parseMcpOAuthCallbackContext, parseMcpOAuthCallbackStateKey } from '@/components/sections/mcp/mcpOAuth';
import { MCP_OAUTH_ORIGIN_DESKTOP } from '@/components/sections/mcp/startMcpAuthorization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SETTINGS_PAGE_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';

/**
 * Handing control back after the browser finished the authorization.
 *
 * This page always runs in a browser, but the flow may have been started from
 * the desktop shell — a different surface entirely. Sending that user to `/`
 * would raise a second copy of the interface in a tab while the real app sits
 * behind it, so the desktop case is returned through its own protocol, which
 * focuses the running window.
 */
const returnToApp = (startedFromDesktop: boolean): void => {
  if (typeof window === 'undefined') return;
  if (startedFromDesktop) {
    window.location.href = 'openchamber://focus/mcp-auth';
    return;
  }
  window.location.replace('/');
};

const parseQueryParam = (params: URLSearchParams, key: string): string | null => {
  const value = params.get(key);
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeMcpAuthErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  if (/oauth state required/i.test(message)) {
    return 'Authorization session expired or was cleared during reload. Return to OpenChamber and click Authorize again.';
  }
  return message;
};

export const McpOAuthCallbackPage: React.FC = () => {
  const completeAuth = useMcpStore((state) => state.completeAuth);
  const [status, setStatus] = React.useState<'working' | 'success' | 'error'>('working');
  const [returnToDesktop, setReturnToDesktop] = React.useState(false);
  const [message, setMessage] = React.useState('Completing MCP authorization...');

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      setStatus('error');
      setMessage('Browser context unavailable.');
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const code = parseQueryParam(params, 'code');
    const callbackContext = parseMcpOAuthCallbackContext(params);
    const callbackStateKey = parseMcpOAuthCallbackStateKey(params);
    const error = parseQueryParam(params, 'error');
    const errorDescription = parseQueryParam(params, 'error_description');

    if (error) {
      if (callbackStateKey) {
        void runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      setStatus('error');
      setMessage(errorDescription ?? error);
      return;
    }

    void (async () => {
      try {
        if (!code) {
          throw new Error('Missing OAuth authorization code. Start authorization again from MCP Settings or paste the returned code into OpenChamber manually.');
        }

        let pendingContext = callbackContext;
        let startedFromDesktop = false;
        // Always consulted, even when the state already carries the server:
        // the origin lives only here, and it decides where the user is sent
        // back to.
        if (callbackStateKey) {
          const response = await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`);
          if (response.ok) {
            const payload = await response.json().catch(() => null) as {
              name?: string;
              directory?: string | null;
              origin?: string | null;
            } | null;
            startedFromDesktop = payload?.origin === MCP_OAUTH_ORIGIN_DESKTOP;
            setReturnToDesktop(startedFromDesktop);
            if (!pendingContext && payload?.name?.trim()) {
              pendingContext = {
                name: payload.name.trim(),
                directory: typeof payload.directory === 'string' && payload.directory.trim() ? payload.directory.trim() : null,
              };
            }
          }
        }

        if (!pendingContext?.name) {
          throw new Error('Authorization session details were not available. Start authorization again from MCP Settings or paste the returned code into OpenChamber manually.');
        }

        await completeAuth(pendingContext.name, code, pendingContext.directory);
        if (callbackStateKey) {
          await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        setStatus('success');
        // Attempted straight away: the user's attention is in a browser tab,
        // and the app they were working in is behind it. The button below
        // stays as the fallback for a browser that blocks the protocol jump.
        if (startedFromDesktop) {
          returnToApp(true);
        }
        setMessage('Authorization completed. You can close this tab and return to OpenChamber.');
      } catch (authError) {
        if (callbackStateKey) {
          await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        setStatus('error');
        setMessage(normalizeMcpAuthErrorMessage(authError, 'Failed to complete MCP authorization.'));
      }
    })();
  }, [completeAuth]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-xl rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-8 shadow-sm">
        <div className="space-y-3 text-center">
          <h1 className={SETTINGS_PAGE_TITLE_CLASS}>
            {status === 'working' ? 'Completing Authorization' : status === 'success' ? 'Authorization Complete' : 'Authorization Failed'}
          </h1>
          <p
            className={cn(
              'typography-body',
              status === 'error'
                ? 'text-[var(--status-error)]'
                : status === 'success'
                  ? 'text-[var(--status-success)]'
                  : 'text-[var(--status-info)]',
            )}
          >
            {message}
          </p>
        </div>

        {status !== 'working' && (
          <div className="mt-8 flex justify-center">
            <Button
              type="button"
              onClick={() => returnToApp(returnToDesktop)}
            >
              Return to OpenChamber
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
