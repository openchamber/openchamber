import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Switch } from '@/components/ui/switch';
import { useMcpStore } from '@/stores/useMcpStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { toast } from 'sonner';
import { startMcpAuthorization } from '@/components/sections/mcp/startMcpAuthorization';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusRowAction } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

type Props = {
  directory: string | null;
};

const MCP_STATUS_MAX_AGE_MS = 60_000;

/**
 * MCP servers with their connection switches, reusing the dropdown's own
 * connect/disconnect actions.
 */
export const WorkStatusMcpSection: React.FC<Props> = ({ directory }) => {
  const { t } = useI18n();

  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(directory), [directory]),
  );
  const ensureMcpFresh = useMcpStore((state) => state.ensureFresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const isConnected = useConfigStore((state) => state.isConnected);
  const [busyServer, setBusyServer] = React.useState<string | null>(null);

  // The panel must not depend on the header dropdown having been mounted or
  // opened to know its MCP servers. Silent and background-gated, so it cannot
  // compete with chat bootstrap traffic for sockets. The section remounts on
  // every session switch, so it only asks for a status that is missing or
  // older than a minute; connect/disconnect/auth refresh on their own.
  // `isConnected` is a dependency, not a gate: MCP status is cached by
  // directory alone and dropped on an instance switch, and two instances can
  // hold the same project path — so the switch itself has to trigger the ask.
  React.useEffect(() => {
    void runBackgroundNetworkTask(() => ensureMcpFresh({ directory, silent: true, maxAgeMs: MCP_STATUS_MAX_AGE_MS }));
  }, [directory, ensureMcpFresh, isConnected]);

  const mcpServers = React.useMemo(
    () => Object.entries(mcpStatus ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [mcpStatus],
  );
  const mcpConnected = React.useMemo(
    () => mcpServers.filter(([, entry]) => entry?.status === 'connected').length,
    [mcpServers],
  );

  // A server waiting on authorization cannot be reconnected into working
  // order: `connect` just repeats the attempt that produced `needs_auth`.
  // Authorising sends the user to the provider instead.
  const handleAuthorize = React.useCallback(async (name: string) => {
    setBusyServer(name);
    try {
      const { opened } = await startMcpAuthorization({
        name,
        directory,
      });
      if (!opened) {
        toast.error(t('chat.workStatus.mcp.authorizeOpenFailed'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('chat.workStatus.mcp.authorizeFailed'));
    } finally {
      setBusyServer((current) => (current === name ? null : current));
    }
  }, [directory, t]);

  const handleToggle = React.useCallback(async (name: string, next: boolean) => {
    // Switching on a server that is waiting for sign-in cannot connect: it only
    // repeats the attempt that produced `needs_auth`. Authorization is the real
    // action, and the dropdown already routes the same switch that way — the
    // two surfaces must not disagree about what this control does.
    const status = (mcpStatus ?? {})[name]?.status;
    if (next && (status === 'needs_auth' || status === 'needs_client_registration')) {
      await handleAuthorize(name);
      return;
    }

    setBusyServer(name);
    try {
      if (next) await connect(name, directory);
      else await disconnect(name, directory);
    } finally {
      setBusyServer((current) => (current === name ? null : current));
    }
  }, [connect, disconnect, directory, handleAuthorize, mcpStatus]);

  useReportWorkStatusPresence('mcp', mcpServers.length > 0);

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
        const busy = busyServer === name;
        const needsAuth = entry?.status === 'needs_auth' || entry?.status === 'needs_client_registration';
        const failed = entry?.status === 'failed';
        return (
          <WorkStatusRow
            key={name}
            leading={(
              <Switch
                checked={connected}
                disabled={busy}
                loading={busy}
                className="scale-75 disabled:opacity-100 data-[checked]:bg-status-info"
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
                disabled={busy}
                onClick={() => { void handleAuthorize(name); }}
              >
                {t('chat.workStatus.mcp.needsAuth')}
              </WorkStatusRowAction>
            ) : failed ? (
              <WorkStatusRowAction
                tone="error"
                disabled={busy}
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
