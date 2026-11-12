import React from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { PROTECTED_SERVICE_PROBLEM_KEYS, useProtectedMcp } from '@/components/sections/mcp/protectedMcp';
import { useI18n } from '@/lib/i18n';
import { grantSpaceAccess, type SpaceEntry } from '@/lib/spaces/spaces-api';
import { spacesRuntimeGeneration, useSpacesStore } from '@/lib/spaces/spaces-store';
import { failureOfError, spaceFailureText } from './spaceFailureText';

function HostMcpAccess({ entry }: { readonly entry: SpaceEntry }) {
  const { t } = useI18n();
  const { state, reload } = useProtectedMcp(entry.projectDirectory);
  const [giving, setGiving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const grants = entry.grants.filter((grant) => grant.kind === 'mcp');
  const service = state.kind === 'ready' ? state.status.service : null;
  const connections = service?.state === 'available' ? service.status.connections : [];
  const canGive = entry.state === 'running' && giving === null && entry.purpose !== 'pr-fix-loop-approval' && service?.state === 'available';
  const give = async (connection: string, name: string) => {
    const generation = spacesRuntimeGeneration();
    setGiving(connection);
    setError(null);
    try {
      const grant = await grantSpaceAccess(entry.id, { kind: 'mcp', connection, name });
      if (generation === spacesRuntimeGeneration()) useSpacesStore.getState().noteGrantGiven(entry.id, grant);
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      if (generation === spacesRuntimeGeneration()) setError(spaceFailureText(t, failureOfError(failure)));
    } finally { setGiving(null); }
  };
  const problem = service && service.state !== 'available' && service.state !== 'unsupported_platform'
    ? t(PROTECTED_SERVICE_PROBLEM_KEYS[service.state]) : t('spaces.access.mcp.unavailable');

  return <div className="space-y-2">
    <p className="typography-meta text-muted-foreground">{t('spaces.access.mcp.irreversible')}</p>
    {grants.map((grant) => {
      const missing = entry.needsAccess.includes(grant.id);
      const unknown = entry.access === 'unknown';
      return <div key={grant.id} className="flex min-w-0 items-center gap-2 typography-meta text-foreground">
        <span className="min-w-0 flex-1 truncate" dir="auto">{grant.name}</span>
        <span className="text-muted-foreground">{t(missing ? 'spaces.access.model.none' : unknown ? 'spaces.group.access.unknown' : 'spaces.access.mcp.given')}</span>
        {missing || unknown ? <Button size="xs" variant="outline" disabled={!canGive} onClick={() => void give(grant.connection, grant.name)}>
          {giving === grant.connection ? <Spinner className="size-3" /> : null}{t('spaces.access.mcp.give')}
        </Button> : null}
      </div>;
    })}
    {state.kind === 'loading' ? <p className="flex items-center gap-1.5 typography-meta text-muted-foreground" role="status"><Spinner className="size-3.5" />{t('spaces.access.loading')}</p>
      : service?.state === 'available' ? <>
        {connections.length === 0 && grants.length === 0 ? <p className="typography-meta text-muted-foreground">{t('spaces.access.mcp.empty')}</p> : null}
        {connections.filter((connection) => !grants.some((grant) => grant.connection === connection.id)).map((connection) => <div key={connection.id} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" dir="auto">{connection.name}</span>
          <Button size="xs" variant="outline" disabled={!canGive}
            aria-busy={giving === connection.id} onClick={() => void give(connection.id, connection.name)}>
            {giving === connection.id ? <Spinner className="size-3" /> : null}{t('spaces.access.mcp.give')}
          </Button>
        </div>)}
      </> : <p className="typography-meta text-status-error" role="alert">{problem}</p>}
    <p className="min-h-4 typography-meta text-status-error" role={error ? 'alert' : undefined}>{error}</p>
    <Button size="xs" variant="ghost" disabled={state.kind === 'loading' || giving !== null} onClick={() => void reload()}>{t('spaces.access.blocked.refresh')}</Button>
  </div>;
}

/** Docker spaces never read protected status and never offer a grant button. */
export function SpaceMcpAccess({ entry }: { readonly entry: SpaceEntry }) {
  const { t } = useI18n();
  switch (entry.kind) {
    case 'docker': return <p className="typography-meta text-muted-foreground">{t('spaces.access.mcp.dockerOnly')}</p>;
    case 'host':
    case 'host-root': return <HostMcpAccess key={entry.id} entry={entry} />;
    default: { const unhandled: never = entry.kind; return unhandled; }
  }
}
