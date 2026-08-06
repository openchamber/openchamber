import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Switch } from '@/components/ui/switch';
import { useMcpStore } from '@/stores/useMcpStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusRowAction } from './WorkStatusPrimitives';

type Props = {
  directory: string | null;
};

/**
 * MCP servers with their connection switches, reusing the dropdown's own
 * connect/disconnect actions.
 */
export const WorkStatusMcpSection: React.FC<Props> = ({ directory }) => {
  const { t } = useI18n();

  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(directory), [directory]),
  );
  const refreshMcp = useMcpStore((state) => state.refresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const [busyServer, setBusyServer] = React.useState<string | null>(null);

  // The panel must not depend on the header dropdown having been mounted or
  // opened to know its MCP servers. Silent and background-gated, so it cannot
  // compete with chat bootstrap traffic for sockets.
  React.useEffect(() => {
    void runBackgroundNetworkTask(() => refreshMcp({ directory, silent: true }));
  }, [directory, refreshMcp]);

  const mcpServers = React.useMemo(
    () => Object.entries(mcpStatus ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [mcpStatus],
  );
  const mcpConnected = React.useMemo(
    () => mcpServers.filter(([, entry]) => entry?.status === 'connected').length,
    [mcpServers],
  );

  const handleToggle = React.useCallback(async (name: string, next: boolean) => {
    setBusyServer(name);
    try {
      if (next) await connect(name, directory);
      else await disconnect(name, directory);
    } finally {
      setBusyServer((current) => (current === name ? null : current));
    }
  }, [connect, disconnect, directory]);

  if (mcpServers.length === 0) return null;

  return (
    <WorkStatusCollapsibleSection
      id="mcp"
      title={t('chat.workStatus.section.mcp')}
      iconNode={<McpIcon className="size-4 shrink-0 text-muted-foreground" />}
      summary={`${mcpConnected}/${mcpServers.length}`}
    >
      {mcpServers.map(([name, entry]) => {
        const connected = entry?.status === 'connected';
        const needsAuth = entry?.status === 'needs_auth' || entry?.status === 'needs_client_registration';
        const failed = entry?.status === 'failed';
        return (
          <WorkStatusRow
            key={name}
            leading={(
              <Switch
                checked={connected}
                disabled={busyServer === name}
                className="scale-75 data-[checked]:bg-status-info"
                aria-label={t('chat.workStatus.mcp.toggle', { name })}
                onCheckedChange={(checked) => { void handleToggle(name, checked); }}
              />
            )}
            label={name}
            muted={!connected}
            // A server asking for sign-in or reporting a failure is asking to be
            // acted on; the state is the affordance, so it is the button.
            value={needsAuth ? (
              <WorkStatusRowAction
                tone="warning"
                disabled={busyServer === name}
                onClick={() => { void handleToggle(name, true); }}
              >
                {t('chat.workStatus.mcp.needsAuth')}
              </WorkStatusRowAction>
            ) : failed ? (
              <WorkStatusRowAction
                tone="error"
                disabled={busyServer === name}
                onClick={() => { void handleToggle(name, true); }}
              >
                {t('chat.workStatus.mcp.failed')}
              </WorkStatusRowAction>
            ) : undefined}
          />
        );
      })}
    </WorkStatusCollapsibleSection>
  );
};
