import React from 'react';
import { Button } from '@/components/ui/button';
import { useMcpStore } from '@/stores/useMcpStore';
import { parseMcpOAuthCallbackContext, parseMcpOAuthCallbackStateKey } from '@/components/sections/mcp/mcpOAuth';

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
        void fetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
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
        if (!pendingContext && callbackStateKey) {
          const response = await fetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`);
          if (response.ok) {
            const payload = await response.json().catch(() => null) as { name?: string; directory?: string | null } | null;
            if (payload?.name?.trim()) {
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
          await fetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        setStatus('success');
        setMessage('Authorization completed. You can close this tab and return to OpenChamber.');
      } catch (authError) {
        if (callbackStateKey) {
          await fetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
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
          <div
            className={status === 'error' ? 'text-[var(--status-error)]' : status === 'success' ? 'text-[var(--status-success)]' : 'text-[var(--status-info)]'}
          >
            <h1 className="typography-hero font-semibold">
              {status === 'working' ? 'Completing Authorization' : status === 'success' ? 'Authorization Complete' : 'Authorization Failed'}
            </h1>
          </div>
          <p className="typography-body text-muted-foreground">{message}</p>
        </div>

        {status !== 'working' && (
          <div className="mt-8 flex justify-center">
            <Button
              type="button"
              onClick={() => {
                if (typeof window === 'undefined') {
                  return;
                }
                window.location.replace('/');
              }}
            >
              Return to OpenChamber
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
