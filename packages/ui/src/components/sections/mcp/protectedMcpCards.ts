import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import { MCP_SCOPE_LABEL_KEYS } from './mcpScope';
import type { ProtectedConnection, ProtectedMcpStatus, ProtectedSelectionRequest } from './protectedMcp';

/** Where a connection is used under one MCP name, in the project Settings shows. */
type ProtectedUse = 'global' | 'project' | 'off-here' | 'unused';

/** A global selection reaches the same projects as the Global scope, and a project selection those of Local project. */
export const PROTECTED_USE_LABEL_KEYS = {
  global: MCP_SCOPE_LABEL_KEYS.user,
  project: MCP_SCOPE_LABEL_KEYS.local,
  'off-here': 'settings.mcp.protected.use.offHere',
  unused: 'settings.mcp.protected.use.unused',
} as const satisfies Record<ProtectedUse, I18nKey>;

/**
 * A connection as the agent sees it: under one MCP name. A selection may give
 * a connection a name of its own, as migrated ones do (`github` for the
 * connection `precocerto-github`), so usage is keyed by name and connection id.
 */
type ProtectedCard = {
  connection: ProtectedConnection;
  name: string;
  use: ProtectedUse;
  /** In all projects, this name points at this connection. */
  global: boolean;
  /** This project has an entry of its own for this name. */
  project: boolean;
};

const usageOf = (status: ProtectedMcpStatus, name: string, id: string): ProtectedUse => {
  const project = status.selections?.project?.[name];
  const global = status.selections?.global[name];
  if (project && !project.disabled && project.connection === id) return 'project';
  if (global && !global.disabled && global.connection === id) {
    // Turned off here, or given to another connection in this project.
    return project ? 'off-here' : 'global';
  }
  return 'unused';
};

/** One card per connection and name it is selected under; an unselected connection shows under its own name. */
export const protectedCards = (status: ProtectedMcpStatus, connections: readonly ProtectedConnection[]): ProtectedCard[] => {
  const global = status.selections?.global ?? {};
  const project = status.selections?.project ?? {};
  const cards: ProtectedCard[] = [];
  for (const connection of connections) {
    const names = new Set<string>();
    for (const selections of [global, project]) {
      for (const [name, entry] of Object.entries(selections)) {
        if (entry.connection === connection.id) names.add(name);
      }
    }
    if (names.size === 0) names.add(connection.name);
    for (const name of names) {
      cards.push({
        connection,
        name,
        use: usageOf(status, name, connection.id),
        global: global[name]?.connection === connection.id,
        project: Boolean(project[name]),
      });
    }
  }
  return cards;
};

/**
 * Whether any selection exists, turned off or not. A turned-off entry leaves
 * nothing effective, but it still points at a connection and may need removing.
 */
export const hasProtectedSelections = (status: ProtectedMcpStatus): boolean =>
  Object.keys(status.selections?.global ?? {}).length > 0 || Object.keys(status.selections?.project ?? {}).length > 0;

/** A name with an entry that points at a connection the service no longer has. */
type OrphanedSelection = {
  name: string;
  /** The entry for all projects is stale. */
  global: boolean;
  /** This project's own entry is stale. */
  project: boolean;
  use: ProtectedUse;
};

/**
 * Names whose global or project entry, turned off or not, points at a
 * connection the service no longer has. Such an entry fails until it is
 * removed, and no connection card shows it.
 */
export const orphanedSelections = (status: ProtectedMcpStatus, connections: readonly ProtectedConnection[]): OrphanedSelection[] => {
  const known = new Set(connections.map((connection) => connection.id));
  const global = status.selections?.global ?? {};
  const project = status.selections?.project ?? {};
  const orphans: OrphanedSelection[] = [];
  for (const name of new Set([...Object.keys(global), ...Object.keys(project)])) {
    const staleGlobal = Boolean(global[name] && !known.has(global[name].connection));
    const staleProject = Boolean(project[name] && !known.has(project[name].connection));
    if (!staleGlobal && !staleProject) continue;
    let use: ProtectedUse = 'global';
    if (staleProject) use = project[name]?.disabled ? 'off-here' : 'project';
    orphans.push({ name, global: staleGlobal, project: staleProject, use });
  }
  return orphans;
};

/** A selection change offered on a card, applied to the selection's own name. */
type ProtectedSelectionAction = {
  id: 'use-everywhere' | 'use-here' | 'turn-off-here' | 'reset-here' | 'stop-everywhere';
  labelKey: I18nKey;
  icon: IconName;
  destructive?: true;
  name: string;
  request: ProtectedSelectionRequest;
};

const resetHere = (name: string): ProtectedSelectionAction => ({
  id: 'reset-here', labelKey: 'settings.mcp.protected.action.resetHere', icon: 'arrow-go-back', name,
  request: { method: 'DELETE', body: { scope: 'project' } },
});

const stopEverywhere = (name: string): ProtectedSelectionAction => ({
  id: 'stop-everywhere', labelKey: 'settings.mcp.protected.action.stopEverywhere', icon: 'close', destructive: true, name,
  request: { method: 'DELETE', body: { scope: 'global' } },
});

/**
 * The selection changes a connection card offers. Every action targets the
 * selection's own name, which a migrated selection may give the connection,
 * and only entries that point at this connection.
 */
export const selectionActions = ({ connection, name, use, global, project }: ProtectedCard, directory: string | null): ProtectedSelectionAction[] => {
  const { id } = connection;
  const actions: ProtectedSelectionAction[] = [];
  if (use !== 'global' && use !== 'project') {
    actions.push({
      id: 'use-everywhere', labelKey: 'settings.mcp.protected.action.useEverywhere', icon: 'global', name,
      request: { method: 'PUT', body: { scope: 'global', connection: id } },
    });
    if (directory) {
      actions.push({
        id: 'use-here', labelKey: 'settings.mcp.protected.action.useHere', icon: 'folder', name,
        request: { method: 'PUT', body: { scope: 'project', connection: id } },
      });
    }
  }
  if (use === 'global' && directory) {
    actions.push({
      id: 'turn-off-here', labelKey: 'settings.mcp.protected.action.turnOffHere', icon: 'close-circle', name,
      request: { method: 'PUT', body: { scope: 'project', connection: id, disabled: true } },
    });
  }
  if (project) actions.push(resetHere(name));
  if (global) actions.push(stopEverywhere(name));
  return actions;
};

/** Only the stale entries of an orphaned name go; one of the same name for a live connection stays on its own card. */
export const orphanActions = ({ name, global, project }: OrphanedSelection): ProtectedSelectionAction[] => [
  ...(project ? [resetHere(name)] : []),
  ...(global ? [stopEverywhere(name)] : []),
];
