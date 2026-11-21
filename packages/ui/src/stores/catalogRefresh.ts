
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

const refreshPlugins = async (): Promise<void> => {
  const { bumpPolicyRevision, loadPlugins } = usePluginsStore.getState();
  bumpPolicyRevision();
  await loadPlugins({ force: true });
};

const refreshProviders = async (): Promise<void> => {
  const config = useConfigStore.getState();
  await config.loadProviders({ source: SOURCE, fresh: true });
};

const PROVIDER_REREAD_AFTER_CREDENTIAL_MS = 5000;

const refreshProvidersAfterCredentialChange = async (): Promise<void> => {
  const sdk = opencodeClient.getSdkClient();
  const isCurrent = captureRuntimeInstance();
  await refreshProviders();
  await new Promise((resolve) => setTimeout(resolve, PROVIDER_REREAD_AFTER_CREDENTIAL_MS));
  if (!isCurrent() || sdk !== opencodeClient.getSdkClient()) return;
  await refreshProviders();
};

const refreshUsageAfterCredentialChange = async (): Promise<void> => {
  await useQuotaStore.getState().refreshAfterCredentialChange();
};

const refreshCredentialReaders = async (): Promise<void> => notifyCredentialChanged();

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
    case "provider":
    case "model":
      return [refreshProviders];
    case "credential":
      return [
        refreshProvidersAfterCredentialChange,
        refreshWebSearchIfLoaded,
        refreshUsageAfterCredentialChange,
        refreshCredentialReaders,
      ];
    case "config":
      return [() => refreshAgents(eventDirectories), () => refreshCommands(eventDirectories), refreshSkills, refreshMcp, refreshPlugins, refreshProviders, refreshWebSearchIfLoaded];
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
  if (tasks.has(refreshProvidersAfterCredentialChange)) tasks.delete(refreshProviders);
  await Promise.allSettled([...tasks].map(([key, task]) => {
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
