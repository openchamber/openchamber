
import type { CatalogKind } from "@/lib/opencode/events";
import { opencodeClient } from "@/lib/opencode/client";
import { captureRuntimeInstance } from "@/lib/runtime-switch";
import { credentialReaderDirectories, notifyCredentialChanged } from "@/lib/opencode/integration-catalog";
import { getConfigDirectory, invalidateAgentsLoadCache, useAgentsStore } from "@/stores/useAgentsStore";
import { invalidateCommandsLoadCache, useCommandsStore } from "@/stores/useCommandsStore";
import { invalidateSkillsLoadCache, useSkillsStore } from "@/stores/useSkillsStore";
import { useSkillsCatalogStore } from "@/stores/useSkillsCatalogStore";
import { invalidateConfigAgentsLoad, useConfigStore } from "@/stores/useConfigStore";
import { fromDirectoryKey } from "@/stores/config/directories";
import { useMcpConfigStore } from "@/stores/useMcpConfigStore";
import { usePluginsStore } from "@/stores/usePluginsStore";
import { useQuotaStore } from "@/stores/useQuotaStore";
import { refreshWebSearchIfLoaded } from "@/stores/useWebSearchStore";

const SOURCE = "catalogRefresh";

const catalogRefreshDirectories = (
  eventDirectories: readonly string[],
  ambientDirectory: string | null = getConfigDirectory(),
): Array<string | null> => {
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

const providerRefreshDirectories = (eventDirectories: readonly string[]): Array<string | null> =>
  catalogRefreshDirectories(eventDirectories, fromDirectoryKey(useConfigStore.getState().activeDirectoryKey));

const refreshProviders = async (directory: string | null): Promise<void> => {
  const config = useConfigStore.getState();
  await config.loadProviders({ directory, source: SOURCE, fresh: true });
};

const PROVIDER_REREAD_AFTER_CREDENTIAL_MS = 5000;

const refreshProvidersAfterCredentialChange = async (
  directory: string | null,
  directories: readonly (string | null)[],
): Promise<void> => {
  const sdk = opencodeClient.getSdkClient();
  const isCurrent = captureRuntimeInstance();
  await refreshProviders(directory);
  await new Promise((resolve) => setTimeout(resolve, PROVIDER_REREAD_AFTER_CREDENTIAL_MS));
  if (!isCurrent() || sdk !== opencodeClient.getSdkClient()) return;
  const activeDirectory = fromDirectoryKey(useConfigStore.getState().activeDirectoryKey);
  const delayedDirectories = (directory === directories[0] && !directories.includes(activeDirectory)
    ? [directory, activeDirectory]
    : [directory]).filter(target => target !== null);
  await Promise.allSettled(delayedDirectories.map(refreshProviders));
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
      return [async () => {
        await Promise.allSettled(providerRefreshDirectories(eventDirectories).map(refreshProviders));
      }];
    case "credential":
      return [
        async () => {
          const directories = providerRefreshDirectories([...eventDirectories, ...credentialReaderDirectories()]);
          await Promise.allSettled(directories.map(directory => refreshProvidersAfterCredentialChange(directory, directories)));
        },
        refreshWebSearchIfLoaded,
        refreshUsageAfterCredentialChange,
        refreshCredentialReaders,
      ];
    case "config":
      return [() => refreshAgents(eventDirectories), () => refreshCommands(eventDirectories), ...catalogRefreshTasks("provider", eventDirectories), refreshSkills, refreshMcp, refreshPlugins, refreshWebSearchIfLoaded];
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
type RefreshRequest = { promise: Promise<void>; isCurrent: () => boolean; revision: number; task: RefreshTask };
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
  const providerDirectories = new Set<string>();
  let agents = false;
  let commands = false;
  let providers = false;
  let credentials = false;
  for (const [kind, directories] of reloads) {
    if (kind === "config" || kind === "agent") {
      agents = true;
      for (const directory of directories) agentDirectories.add(directory);
    }
    if (kind === "config" || kind === "command") {
      commands = true;
      for (const directory of directories) commandDirectories.add(directory);
    }
    if (kind === "config" || kind === "provider" || kind === "model" || kind === "credential") {
      providers = true;
      for (const directory of directories) providerDirectories.add(directory);
    }
    if (kind === "credential") {
      credentials = true;
      for (const directory of credentialReaderDirectories()) providerDirectories.add(directory);
    }
    const kindTasks = catalogRefreshTasks(kind, directories);
    const scopedTasks = kind === "config" ? 3
      : kind === "agent" || kind === "command" || kind === "provider" || kind === "model" || kind === "credential" ? 1 : 0;
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
  if (providers) {
    const directories = providerRefreshDirectories([...providerDirectories]);
    for (const directory of directories) {
      tasks.set(JSON.stringify([credentials ? "credentialProviders" : "providers", directory]), () => credentials
        ? refreshProvidersAfterCredentialChange(directory, directories)
        : refreshProviders(directory));
    }
  }
  await Promise.allSettled([...tasks].map(([key, task]) => {
    if (task === refreshUsageAfterCredentialChange) return task();
    const scope = key instanceof Function ? JSON.stringify([getConfigDirectory(), useConfigStore.getState().activeDirectoryKey]) : key;
    const requests = inFlight.get(key) ?? new Map<string, RefreshRequest>();
    inFlight.set(key, requests);
    const existing = requests.get(scope);
    if (existing?.isCurrent()) {
      existing.revision += 1;
      existing.task = task;
      return existing.promise;
    }
    const isCurrent = captureRuntimeInstance();
    const entry: RefreshRequest = { promise: Promise.resolve(), isCurrent, revision: 0, task };
    const request: Promise<void> = (async () => {
      let startedRevision: number;
      do {
        startedRevision = entry.revision;
        try {
          const refreshTask = entry.task;
          await refreshTask();
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
