import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CatalogKind } from "@/lib/opencode/events";
import type { Project } from "@/lib/opencode/model";

const refreshCalls: Array<{ kind: CatalogKind; directories: readonly string[] }> = [];

mock.module("@/stores/catalogRefresh", () => ({
  refreshStoresForCatalogKind: async (kind: CatalogKind, directories: readonly string[] = []) => {
    refreshCalls.push({ kind, directories });
  },
}));

const { opencodeClient } = await import("@/lib/opencode/client");
const { getRuntimeKey, switchRuntimeEndpoint } = await import("@/lib/runtime-switch");
const { ChildStoreManager } = await import("./child-store");
const { useGlobalSyncStore } = await import("./global-sync-store");
const { createEventRoutingIndex, handleEvent } = await import("./sync-context");

const originalListAgents = opencodeClient.listAgents;
const originalListProjects = opencodeClient.listProjects;
let childStores: InstanceType<typeof ChildStoreManager>;

const project = (id: string): Project => ({
  id,
  worktree: `/workspace/${id}`,
  time: { created: 1, updated: 1 },
  sandboxes: [],
});

const deferred = <T>() => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

describe("catalog refresh routing", () => {
  beforeEach(() => {
    refreshCalls.length = 0;
    childStores = new ChildStoreManager();
    childStores.ensureChild("/workspace/project", { bootstrap: false });
    opencodeClient.listAgents = async () => [];
    opencodeClient.listProjects = originalListProjects;
    useGlobalSyncStore.getState().actions.reset();
  });

  afterEach(() => {
    opencodeClient.listAgents = originalListAgents;
    opencodeClient.listProjects = originalListProjects;
    childStores.disposeAll();
  });

  test("a location-scoped catalog event reloads even when its directory store exists", async () => {
    handleEvent(
      "/workspace/project",
      { type: "catalog.updated", properties: { kind: "agent" } },
      childStores,
      createEventRoutingIndex(),
      getRuntimeKey(),
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(refreshCalls).toEqual([{
      kind: "agent",
      directories: ["/workspace/project"],
    }]);
  });

  test("a catalog reload captured for an old runtime is discarded", async () => {
    handleEvent(
      "/workspace/project",
      { type: "catalog.updated", properties: { kind: "agent" } },
      childStores,
      createEventRoutingIndex(),
      "stale-runtime",
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(refreshCalls).toEqual([]);
  });

  test("a project catalog response cannot publish after its runtime changes", async () => {
    const currentRuntime = getRuntimeKey();
    const projectsResponse = deferred<Project[]>();
    const projectsStarted = deferred<void>();
    const retainedProjects = [project("runtime-b")];
    opencodeClient.listProjects = () => {
      projectsStarted.resolve();
      return projectsResponse.promise;
    };
    useGlobalSyncStore.getState().actions.set({ projects: retainedProjects });

    handleEvent(
      "global",
      { type: "catalog.updated", properties: { kind: "project" } },
      childStores,
      createEventRoutingIndex(),
      currentRuntime,
    );
    await projectsStarted.promise;

    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-b.test", runtimeKey: "runtime-b" });
    projectsResponse.resolve([project("runtime-a")]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useGlobalSyncStore.getState().projects).toBe(retainedProjects);
  });
});
