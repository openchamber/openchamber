import React from 'react';
import { Button } from '@/components/ui/button';
import { useMcpStore } from '@/stores/useMcpStore';

const parseQueryParam = (params: URLSearchParams, key: string): string | null => {
  const value = params.get(key);
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

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
    const name = parseQueryParam(params, 'server');
    const directory = parseQueryParam(params, 'directory');
    const error = parseQueryParam(params, 'error');
    const errorDescription = parseQueryParam(params, 'error_description');

    if (error) {
      setStatus('error');
      setMessage(errorDescription ?? error);
      return;
    }

    if (!code || !name) {
      setStatus('error');
      setMessage('Missing OAuth callback details. Start authorization again from MCP Settings.');
      return;
    }

    void (async () => {
      try {
        await completeAuth(name, code, directory);
        setStatus('success');
        setMessage('Authorization completed. You can close this tab and return to OpenChamber.');
      } catch (authError) {
        setStatus('error');
        setMessage(authError instanceof Error ? authError.message : 'Failed to complete MCP authorization.');
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
