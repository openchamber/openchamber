import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useMcpStore } from '@/stores/useMcpStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { toast } from 'sonner';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusRowAction } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { WorkStatusTouchContext } from './touchContext';
import { useMcpDirectory } from '@/components/mcp/useMcpDirectory';
import { McpOAuthSignIn } from '@/components/sections/mcp/McpOAuthSignIn';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const MCP_STATUS_MAX_AGE_MS = 60_000;

/** A sign-in the user started from a row; `run` is unique per press. */
type SignInRequest = { server: string; directory: string; run: number };

/**
 * MCP servers with their on/off switches, reusing the dropdown's own action.
 */
export const WorkStatusMcpSection: React.FC<Props> = ({ sessionId, directory: selectedDirectory }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  const { t } = useI18n();
  const directory = useMcpDirectory(true, { sessionId, directory: selectedDirectory });

  const mcpStatus = useMcpStore(
    React.useCallback((state) => directory ? state.getStatusForDirectory(directory) : null, [directory]),
  );
  const ensureMcpFresh = useMcpStore((state) => state.ensureFresh);
  const setEnabled = useMcpStore((state) => state.setEnabled);
  const connect = useMcpStore((state) => state.connect);
  const expanded = useUIStore((state) => state.workStatusExpandedSections.mcp === true);
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
    if (!directory) return;
    void runBackgroundNetworkTask(() => ensureMcpFresh({ directory, silent: true, maxAgeMs: MCP_STATUS_MAX_AGE_MS }));
  }, [directory, ensureMcpFresh, isConnected]);

  const mcpServers = React.useMemo(
    () => Object.entries(mcpStatus ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [mcpStatus],
  );
  const mcpConnected = React.useMemo(
    () => mcpServers.filter(([, entry]) => entry?.status.status === 'connected').length,
    [mcpServers],
  );

  // A server waiting on authorization cannot be reconnected into working
  // order: `connect` just repeats the attempt that produced `needs_auth`.
  // Signing in is the action, through the same OAuth flow Settings runs; its
  // progress shows under the row. Each press starts a fresh attempt.
  const [signIn, setSignIn] = React.useState<SignInRequest | null>(null);
  const signInRunRef = React.useRef(0);
  const startSignIn = React.useCallback((name: string) => {
    if (!directory) return;
    signInRunRef.current += 1;
    setSignIn({ server: name, directory, run: signInRunRef.current });
  }, [directory]);

  // A sign-in lives only while its section is open, in its own directory,
  // and while its server still asks for one. Folding unmounts it (which
  // cancels the attempt upstream), and OpenCode reconnects a server on its
  // own once the credential is stored, often before the attempt reports
  // back. Dropping the request in all of these cases keeps a later
  // `needs_auth` from starting a sign-in nobody pressed for.
  const liveSignIn = signIn
    && expanded
    && signIn.directory === directory
    && mcpStatus?.[signIn.server]?.status.status === 'needs_auth'
    ? signIn
    : null;
  React.useEffect(() => {
    if (signIn && !liveSignIn) setSignIn(null);
  }, [liveSignIn, signIn]);

  const handleSignedIn = React.useCallback(async (request: SignInRequest) => {
    // An older attempt that finishes late must not end a newer one.
    setSignIn((current) => (current?.run === request.run ? null : current));
    setBusyServer(request.server);
    try {
      await connect(request.server, request.directory);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.mcp.page.toast.connectionFailed'));
    } finally {
      setBusyServer((current) => (current === request.server ? null : current));
    }
  }, [connect, t]);

  // The lookup gave up (the integration list kept failing, or the server has
  // no OAuth method): say where to go instead of leaving the press unanswered.
  const handleSignInUnavailable = React.useCallback((request: SignInRequest) => {
    setSignIn((current) => (current?.run === request.run ? null : current));
    toast.message(t('chat.workStatus.mcp.needsAuthHint'));
  }, [t]);

  const handleToggle = React.useCallback(async (name: string, next: boolean) => {
    if (!directory) return;
    // Switching on a server that is waiting for sign-in cannot connect: it only
    // repeats the attempt that produced `needs_auth`, so the switch signs in,
    // as the row's own Sign in does.
    const status = (mcpStatus ?? {})[name]?.status.status;
    if (next && status === 'needs_auth') {
      startSignIn(name);
      return;
    }

    setBusyServer(name);
    try {
      await setEnabled(name, next, directory);
    } finally {
      setBusyServer((current) => (current === name ? null : current));
    }
  }, [directory, mcpStatus, setEnabled, startSignIn]);

  useReportWorkStatusPresence('mcp', mcpServers.length > 0);

  if (mcpServers.length === 0) return null;

  return (
    <WorkStatusCollapsibleSection
      id="mcp"
      title={t('chat.workStatus.section.mcp')}
      iconNode={<McpIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      summary={`${mcpConnected}/${mcpServers.length}`}
    >
      {mcpServers.map(([name, entry]) => {
        const connected = entry?.status.status === 'connected';
        const busy = busyServer === name;
        const needsAuth = entry?.status.status === 'needs_auth';
        const failed = entry?.status.status === 'failed';
        const toggle = (
          <Switch
            checked={connected}
            disabled={busy}
            loading={busy}
            className={cn('disabled:opacity-100 data-[checked]:bg-status-info', !touch && 'scale-75')}
            aria-label={t('chat.workStatus.mcp.toggle', { name })}
            onCheckedChange={(checked) => { void handleToggle(name, checked); }}
          />
        );
        // A server asking for sign-in or reporting a failure is asking to be
        // acted on; the state is the affordance, so it is the button.
        const stateAction = needsAuth ? (
          <WorkStatusRowAction
            tone="warning"
            disabled={busy}
            onClick={() => startSignIn(name)}
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
        ) : null;
        const rowSignIn = liveSignIn?.server === name ? liveSignIn : null;
        return (
          <React.Fragment key={name}>
            <WorkStatusRow
              // On the phone a switch goes on the row's end, full size, as
              // settings rows put it; the icon column is too narrow for one.
              leading={touch ? undefined : toggle}
              label={name}
              muted={!connected}
              value={touch ? <>{stateAction}{toggle}</> : stateAction ?? undefined}
            />
            {rowSignIn ? (
              // Indented like a row's note: it belongs to the row above.
              <div className={touch ? 'mb-2 ms-[2.625rem] me-2.5' : 'mx-1 mb-1'}>
                <McpOAuthSignIn
                  key={rowSignIn.run}
                  serverName={name}
                  directory={rowSignIn.directory}
                  autoStart
                  showStartButton={false}
                  connectLabel={t('chat.workStatus.mcp.needsAuth')}
                  onConnected={() => handleSignedIn(rowSignIn)}
                  onUnavailable={() => handleSignInUnavailable(rowSignIn)}
                />
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </WorkStatusCollapsibleSection>
  );
};
