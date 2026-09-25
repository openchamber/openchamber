import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Agent } from "@/lib/opencode/model";

let runtimeFetchImpl = async (): Promise<Response> => Response.json({
  scope: "project",
  sources: {},
});

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: () => runtimeFetchImpl(),
}));

const { opencodeClient } = await import("@/lib/opencode/client");
const { useConfigStore } = await import("@/stores/useConfigStore");
const {
  invalidateAgentsLoadCache,
  selectAgentsForDirectory,
  useAgentsStore,
} = await import("./useAgentsStore");
const { refreshStoresForCatalogKind } = await import("./catalogRefresh");

const originalListAgents = opencodeClient.listAgents;

const agent = (name: string): Agent => ({
  id: name,
  name,
  displayName: name,
  mode: "subagent",
  request: { settings: {}, headers: {}, body: {} },
  hidden: false,
  permissions: [],
});

const deferred = <T>() => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

describe("agent catalog refresh", () => {
  beforeEach(() => {
    runtimeFetchImpl = async () => Response.json({ scope: "project", sources: {} });
    useAgentsStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    opencodeClient.listAgents = originalListAgents;
  });

  test("refreshes the directory named by the catalog event", async () => {
    const directory = "/workspace/settings-project";
    const originalAgentsLoad = useAgentsStore.getState().loadAgents;
    const originalConfigLoad = useConfigStore.getState().loadAgents;
    const agentLoadDirectories: Array<string | null | undefined> = [];
    const configLoadDirectories: Array<string | null | undefined> = [];
    const agentLoads: typeof originalAgentsLoad = async (loadedDirectory) => {
      agentLoadDirectories.push(loadedDirectory);
      return true;
    };
    const configLoads: typeof originalConfigLoad = async (options) => {
      configLoadDirectories.push(options?.directory);
      return true;
    };

    useAgentsStore.setState({ loadAgents: agentLoads });
    useConfigStore.setState({ loadAgents: configLoads });

    try {
      await refreshStoresForCatalogKind("agent", [directory]);

      expect(agentLoadDirectories).toContain(directory);
      expect(configLoadDirectories).toContain(directory);
    } finally {
      useAgentsStore.setState({ loadAgents: originalAgentsLoad });
      useConfigStore.setState({ loadAgents: originalConfigLoad });
    }
  });

  test("cache invalidation supersedes a pre-change load for the same directory", async () => {
    const directory = "/workspace/racing-project";
    const staleResponse = deferred<Agent[]>();
    let listCalls = 0;

    opencodeClient.listAgents = async () => {
      listCalls += 1;
      if (listCalls === 1) return staleResponse.promise;
      return [agent("new-agent")];
    };

    const staleLoad = useAgentsStore.getState().loadAgents(directory);
    expect(listCalls).toBe(1);

    invalidateAgentsLoadCache(directory);
    const freshLoad = useAgentsStore.getState().loadAgents(directory);
    staleResponse.resolve([agent("old-agent")]);

    expect(listCalls).toBe(2);
    expect(await staleLoad).toBe(false);
    expect(await freshLoad).toBe(true);
    expect(selectAgentsForDirectory(useAgentsStore.getState(), directory).map((entry) => entry.name))
      .toEqual(["new-agent"]);
  });

  test("runtime reset rejects an older load for the same directory", async () => {
    const directory = "/workspace/runtime-switch";
    const staleResponse = deferred<Agent[]>();
    let listCalls = 0;

    opencodeClient.listAgents = async () => {
      listCalls += 1;
      if (listCalls === 1) return staleResponse.promise;
      return [agent("new-runtime-agent")];
    };

    const staleLoad = useAgentsStore.getState().loadAgents(directory);
    useAgentsStore.getState().resetForRuntimeSwitch();
    const freshLoad = useAgentsStore.getState().loadAgents(directory);
    staleResponse.resolve([agent("old-runtime-agent")]);

    expect(await staleLoad).toBe(false);
    expect(await freshLoad).toBe(true);
    expect(selectAgentsForDirectory(useAgentsStore.getState(), directory).map((entry) => entry.name))
      .toEqual(["new-runtime-agent"]);
  });
});
