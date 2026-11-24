import React from 'react';
import type { Integration, McpServerStatus } from '@/lib/opencode/model';
import { useMcpStore } from '@/stores/useMcpStore';

export function useMcpSavedOAuthReconnect(
  actionKey: string,
  directory: string | null,
  status: McpServerStatus | undefined,
  integration: Integration | null,
  eligible: boolean,
) {
  const reconnect = useMcpStore((state) => state.reconnectSavedOAuth);
  const visit = React.useRef<{ controller: AbortController; attempted: boolean } | null>(null);
  const [busy, setBusy] = React.useState<{ key: string; controller: AbortController } | null>(null);
  const reconnecting = busy?.key === actionKey;
  React.useEffect(() => {
    const controller = new AbortController();
    visit.current = { controller, attempted: false };
    return () => controller.abort();
  }, [actionKey]);

  React.useEffect(() => {
    const current = visit.current;
    if (!eligible || reconnecting || !current || current.attempted || !directory || !status || !integration
      || status.integrationID !== integration.id
      || (status.status.status !== 'failed' && status.status.status !== 'needs_auth')
      || !integration.connections.some((entry) => entry.type === 'credential' && entry.method === 'oauth')) return;

    current.attempted = true;
    setBusy({ key: actionKey, controller: current.controller });
    void reconnect(status.name, directory, integration.id, current.controller.signal)
      .catch(() => undefined)
      .finally(() => {
        setBusy((previous) => previous?.controller === current.controller ? null : previous);
      });
  }, [actionKey, directory, eligible, integration, reconnect, reconnecting, status]);

  React.useEffect(() => {
    if (!eligible && busy?.key === actionKey) busy.controller.abort();
  }, [actionKey, busy, eligible]);

  const skipReconnect = React.useCallback(() => {
    if (visit.current) visit.current.attempted = true;
  }, []);
  return { reconnecting, skipReconnect };
}
