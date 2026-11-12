/**
 * Re-reads the Settings-facing lists after OpenCode rebuilt a catalog.
 *
 * OpenCode v2 watches its own config files and publishes what it rebuilt, so a
 * file written by OpenChamber, by the user's editor, or by another client all
 * arrive the same way. The sync layer refreshes its own slices; this module
 * refreshes the stores the Settings pages and the composer read, so an agent
 * added on disk shows up in the list without anyone pressing a button.
 *
 * Every refresh is best-effort: a failed list leaves the previous one in place
 * and the next event or a page visit re-reads it.
 */

import type { CatalogKind } from "@/lib/opencode/events";
import { opencodeClient } from "@/lib/opencode/client";
import { captureRuntimeInstance } from "@/lib/runtime-switch";
import { notifyCredentialChanged } from "@/lib/opencode/integration-catalog";
import { getConfigDirectory, invalidateAgentsLoadCache, useAgentsStore } from "@/stores/useAgentsStore";
import { invalidateCommandsLoadCache, useCommandsStore } from "@/stores/useCommandsStore";
import { invalidateSkillsLoadCache, useSkillsStore } from "@/stores/useSkillsStore";
import { useSkillsCatalogStore } from "@/stores/useSkillsCatalogStore";
import { invalidateConfigAgentsLoad, useConfigStore } from "@/stores/useConfigStore";
import { useMcpConfigStore } from "@/stores/useMcpConfigStore";
import { usePluginsStore } from "@/stores/usePluginsStore";
import { useQuotaStore } from "@/stores/useQuotaStore";
import { refreshWebSearchIfLoaded } from "@/stores/useWebSearchStore";

const SOURCE = "catalogRefresh";

const catalogRefreshDirectories = (eventDirectories: readonly string[]): Array<string | null> => {
  const ambientDirectory = getConfigDirectory();
  const scopedDirectories = Array.from(new Set(
    eventDirectories
      .map((directory) => directory.trim())
      .filter((directory) => directory.length > 0 && directory !== "global" && directory !== ambientDirectory),
  ));

  return [ambientDirectory, ...scopedDirectories];
};

const refreshAgentDirectory = async (directory: string | null): Promise<void> => {
  invalidateAgentsLoadCache(directory);
  invalidateConfigAgentsLoad(directory);

  await Promise.allSettled([
    useAgentsStore.getState().loadAgents(directory),
    useConfigStore.getState().loadAgents({ directory, source: SOURCE, fresh: true }),
  ]);
};

const refreshAgents = async (eventDirectories: readonly string[] = []): Promise<void> => {
  await Promise.all(catalogRefreshDirectories(eventDirectories).map(refreshAgentDirectory));
};

const refreshCommandDirectory = async (directory: string | null): Promise<void> => {
  invalidateCommandsLoadCache(directory);
  await useCommandsStore.getState().loadCommands(directory);
};

const refreshCommands = async (eventDirectories: readonly string[] = []): Promise<void> => {
  await Promise.allSettled(catalogRefreshDirectories(eventDirectories).map(refreshCommandDirectory));
};

const refreshSkills = async (): Promise<void> => {
  invalidateSkillsLoadCache();
  await Promise.allSettled([
    useSkillsStore.getState().loadSkills(),
    useSkillsCatalogStore.getState().loadCatalog({ refresh: true }),
  ]);
};

const refreshMcp = async (): Promise<void> => {
  await useMcpConfigStore.getState().loadMcpConfigs({ force: true });
};

// The policy readers follow the list: a switch flipped here or in another
// client reaches OpenCode's config only after the write, so this event is what
// shows the change.
const refreshPlugins = async (): Promise<void> => {
  const { bumpPolicyRevision, loadPlugins } = usePluginsStore.getState();
  bumpPolicyRevision();
  await loadPlugins({ force: true });
};

// The current list stays on screen until the fresh one lands: emptying it
// first would blank the composer's model and effort pickers and every message
// footer's effort label for the length of the request. `loadProviders` keeps
// the existing objects when nothing changed. The read is fresh: one already in
// flight, say from opening a worktree, began before this change and can answer
// with the catalog OpenCode just replaced.
const refreshProviders = async (): Promise<void> => {
  const config = useConfigStore.getState();
  await config.loadProviders({ source: SOURCE, fresh: true });
};

/**
 * How long after a credential change the model list is read a second time.
 *
 * 2.0.8's `model.updated` only fires when OpenCode's own provider snapshot
 * changes, which it recomputes from integration and credential events. A
 * provider plugin that fetches its models from the provider after a login
 * (Copilot, LM Studio) lands later and announces nothing, so the first read
 * right after `credential.updated` can still land before those models exist.
 */
const PROVIDER_REREAD_AFTER_CREDENTIAL_MS = 5000;

const refreshProvidersAfterCredentialChange = async (): Promise<void> => {
  const sdk = opencodeClient.getSdkClient();
  const isCurrent = captureRuntimeInstance();
  await refreshProviders();
  await new Promise((resolve) => setTimeout(resolve, PROVIDER_REREAD_AFTER_CREDENTIAL_MS));
  if (!isCurrent() || sdk !== opencodeClient.getSdkClient()) return;
  await refreshProviders();
};

/**
 * A credential event is the live channel for "which account is active", so the
 * usage trackers re-read from it rather than from whichever screen switched the
 * account. That is also what covers a switch made in OpenCode's own TUI or by
 * another client, which no OpenChamber screen can see.
 *
 * Old-account samples are invalidated even while hidden. Only a visible quota
 * readout asks providers for replacement samples.
 */
const refreshUsageAfterCredentialChange = async (): Promise<void> => {
  await useQuotaStore.getState().refreshAfterCredentialChange();
};

const refreshCredentialReaders = async (): Promise<void> => notifyCredentialChanged();

/** The lists a catalog kind invalidates, in the order they are re-read. */
export function catalogRefreshTasks(
  kind: CatalogKind,
  eventDirectories: readonly string[] = [],
): Array<() => Promise<void>> {
  switch (kind) {
    case "agent":
      return [() => refreshAgents(eventDirectories)];
    case "command":
      return [() => refreshCommands(eventDirectories)];
    case "skill":
      return [refreshSkills];
    case "plugin":
      return [refreshPlugins];
    // `provider.updated` and `model.updated` (2.0.8) are OpenCode's own
    // deduplicated announcements that the provider list, or the model list it
    // materialises, changed. Both are answered by re-reading the provider list,
    // which is where the composer's models come from.
    case "provider":
    case "model":
      return [refreshProviders];
    // A web search key is a credential too, and a switch of provider accounts
    // changes which account the usage trackers report on and which one an open
    // provider page marks active.
    case "credential":
      return [
        refreshProvidersAfterCredentialChange,
        refreshWebSearchIfLoaded,
        refreshUsageAfterCredentialChange,
        refreshCredentialReaders,
      ];
    // A config file can carry any of them (a provider declared in
    // opencode.json included), and OpenChamber's own plugin injection lives
    // in one, so the whole set is re-read.
    case "config":
      return [() => refreshAgents(eventDirectories), () => refreshCommands(eventDirectories), refreshSkills, refreshMcp, refreshPlugins, refreshProviders, refreshWebSearchIfLoaded];
    // Projects are the sync layer's own slice; nothing in Settings reads them
    // through these stores.
    case "project":
      return [];
    case "websearch":
      return [refreshWebSearchIfLoaded];
  }
}

export async function refreshStoresForCatalogKind(
  kind: CatalogKind,
  eventDirectories: readonly string[] = [],
): Promise<void> {
  return refreshStoresForCatalogKinds(new Map([[kind, eventDirectories]]));
}

// Entries live only for the duration of a refresh. SDK identity isolates
// reconnects; the captured instance also rejects an A -> B -> A switch before
// the SDK reconnects.
type RefreshTask = () => Promise<void>;
type RefreshRequest = { promise: Promise<void>; isCurrent: () => boolean; revision: number };
const inFlightRefreshes = new WeakMap<object, Map<string | RefreshTask, Map<string, RefreshRequest>>>();

export async function refreshStoresForCatalogKinds(
  reloads: ReadonlyMap<CatalogKind, readonly string[]>,
): Promise<void> {
  const sdk = opencodeClient.getSdkClient();
  const inFlight = inFlightRefreshes.get(sdk) ?? new Map<string | RefreshTask, Map<string, RefreshRequest>>();
  inFlightRefreshes.set(sdk, inFlight);
  const tasks = new Map<string | (() => Promise<void>), () => Promise<void>>();
  const agentDirectories = new Set<string>();
  const commandDirectories = new Set<string>();
  let agents = false;
  let commands = false;
  for (const [kind, directories] of reloads) {
    if (kind === "config" || kind === "agent") {
      agents = true;
      for (const directory of directories) agentDirectories.add(directory);
    }
    if (kind === "config" || kind === "command") {
      commands = true;
      for (const directory of directories) commandDirectories.add(directory);
    }
    const kindTasks = catalogRefreshTasks(kind, directories);
    // Directory-scoped tasks capture their locations; union those below.
    const scopedTasks = kind === "config" ? 2 : kind === "agent" || kind === "command" ? 1 : 0;
    for (const task of kindTasks.slice(scopedTasks)) {
      tasks.set(task, task);
    }
  }
  if (agents) {
    for (const directory of catalogRefreshDirectories([...agentDirectories])) {
      tasks.set(JSON.stringify(["agents", directory]), () => refreshAgentDirectory(directory));
    }
  }
  if (commands) {
    for (const directory of catalogRefreshDirectories([...commandDirectories])) {
      tasks.set(JSON.stringify(["commands", directory]), () => refreshCommandDirectory(directory));
    }
  }
  // Credential changes already include the immediate provider read.
  if (tasks.has(refreshProvidersAfterCredentialChange)) tasks.delete(refreshProviders);
  await Promise.allSettled([...tasks].map(([key, task]) => {
    // Each credential event retires old-account requests immediately, even
    // while the preceding event's replacement quota load is still pending.
    if (task === refreshUsageAfterCredentialChange) return task();
    const scope = key instanceof Function ? JSON.stringify([getConfigDirectory(), useConfigStore.getState().activeDirectoryKey]) : key;
    const requests = inFlight.get(key) ?? new Map<string, RefreshRequest>();
    inFlight.set(key, requests);
    const existing = requests.get(scope);
    if (existing?.isCurrent()) {
      existing.revision += 1;
      return existing.promise;
    }
    const isCurrent = captureRuntimeInstance();
    const entry: RefreshRequest = { promise: Promise.resolve(), isCurrent, revision: 0 };
    const request: Promise<void> = (async () => {
      let startedRevision: number;
      do {
        startedRevision = entry.revision;
        try {
          await task();
        } catch (error) {
          if (!isCurrent() || entry.revision === startedRevision) throw error;
        }
      } while (isCurrent() && entry.revision !== startedRevision);
    })().finally(() => {
      if (requests.get(scope)?.promise === request) requests.delete(scope);
      if (requests.size === 0) inFlight.delete(key);
    });
    entry.promise = request;
    requests.set(scope, entry);
    return request;
  }));
}
