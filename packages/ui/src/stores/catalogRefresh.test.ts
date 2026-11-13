import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { QUOTA_PROVIDERS } from "@/lib/quota/providers";
import { subscribeCredentialChanges } from "@/lib/opencode/integration-catalog";
import { catalogRefreshTasks, refreshStoresForCatalogKinds } from "./catalogRefresh";
import { useQuotaStore } from "./useQuotaStore";
import { useAgentsStore } from "./useAgentsStore";
import { useConfigStore } from "./useConfigStore";
import { useCommandsStore } from "./useCommandsStore";
import { useSkillsStore } from "./useSkillsStore";
import { useSkillsCatalogStore } from "./useSkillsCatalogStore";
import { useMcpConfigStore } from "./useMcpConfigStore";
import { usePluginsStore } from "./usePluginsStore";
import { useProjectsStore } from "./useProjectsStore";
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch";

describe("catalogRefreshTasks", () => {
  test("an A to B to A runtime switch cannot join or retire the old refresh", async () => {
    const originalKey = getRuntimeKey();
    const originalBase = getRuntimeApiBaseUrl();
    let releaseOld = () => {};
    let releaseCurrent = () => {};
    const old = new Promise<void>((resolve) => { releaseOld = resolve; });
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const providers = spyOn(useConfigStore.getState(), "loadProviders")
      .mockImplementationOnce(() => old).mockImplementation(() => current);
    try {
      const reloads = new Map([["model" as const, []]]);
      const first = refreshStoresForCatalogKinds(reloads);
      switchRuntimeEndpoint({ runtimeKey: "catalog-runtime-b", apiBaseUrl: "https://catalog-b.test" });
      switchRuntimeEndpoint({ runtimeKey: originalKey, apiBaseUrl: originalBase });
      const second = refreshStoresForCatalogKinds(reloads);
      expect(providers).toHaveBeenCalledTimes(2);
      releaseOld();
      await first;
      const joined = refreshStoresForCatalogKinds(reloads);
      expect(providers).toHaveBeenCalledTimes(2);
      releaseCurrent();
      await Promise.all([second, joined]);
      expect(providers).toHaveBeenCalledTimes(3);
    } finally {
      releaseOld();
      releaseCurrent();
      providers.mockRestore();
      switchRuntimeEndpoint({ runtimeKey: originalKey, apiBaseUrl: originalBase });
    }
  });

  test("invalidations during a catalog read coalesce into one trailing read per resource", async () => {
    const previousProjects = useProjectsStore.getState();
    useProjectsStore.setState({ projects: [{ id: "catalog", path: "/workspace/ambient" }], activeProjectId: "catalog" });
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const agents = spyOn(useAgentsStore.getState(), "loadAgents").mockImplementation(async () => { await pending; return true; });
    const configAgents = spyOn(useConfigStore.getState(), "loadAgents").mockImplementation(async () => { await pending; return true; });
    const providers = spyOn(useConfigStore.getState(), "loadProviders").mockImplementation(() => pending);
    const metadata = spyOn(useConfigStore.getState(), "invalidateModelMetadataCache");
    const commands = spyOn(useCommandsStore.getState(), "loadCommands").mockImplementation(async () => { await pending; return true; });
    const skills = spyOn(useSkillsStore.getState(), "loadSkills").mockImplementation(async () => { await pending; return true; });
    const catalog = spyOn(useSkillsCatalogStore.getState(), "loadCatalog").mockImplementation(async () => { await pending; return true; });
    const mcp = spyOn(useMcpConfigStore.getState(), "loadMcpConfigs").mockImplementation(async () => { await pending; return true; });
    const plugins = spyOn(usePluginsStore.getState(), "loadPlugins").mockImplementation(async () => { await pending; return true; });
    const spies = [agents, configAgents, providers, metadata, commands, skills, catalog, mcp, plugins];
    try {
      const reloads = new Map([
        ["config" as const, ["/workspace/event"]],
        ["agent" as const, ["/workspace/event"]],
        ["provider" as const, []],
        ["model" as const, []],
        ["skill" as const, []],
        ["plugin" as const, []],
      ]);
      const triggers = Array.from({ length: 8 }, () => refreshStoresForCatalogKinds(reloads));
      expect(agents.mock.calls.map(([directory]) => directory).sort()).toEqual(["/workspace/ambient", "/workspace/event"]);
      expect(configAgents).toHaveBeenCalledTimes(2);
      for (const request of [providers, commands, skills, catalog, mcp, plugins]) expect(request).toHaveBeenCalledTimes(1);
      expect(metadata).not.toHaveBeenCalled();
      release();
      await Promise.all(triggers);
      for (const request of [providers, commands, skills, catalog, mcp, plugins]) expect(request).toHaveBeenCalledTimes(2);
      expect(agents).toHaveBeenCalledTimes(4);
      // Settled work is removed: a later file edit still refreshes the lists.
      await refreshStoresForCatalogKinds(reloads);
      expect(providers).toHaveBeenCalledTimes(3);
    } finally {
      release();
      for (const spy of spies) spy.mockRestore();
      useProjectsStore.setState(previousProjects);
    }
  });

  test("a config rebuild re-reads every list a config file can carry", () => {
    // Agents, commands, skills, MCP servers, plugins and providers all live
    // in config, and OpenChamber's own plugin injection is one of them. So
    // does the web search choice.
    expect(catalogRefreshTasks("config")).toHaveLength(7);
  });

  test("a single-catalog rebuild re-reads only that list", () => {
    for (const kind of ["agent", "command", "skill", "plugin", "provider", "websearch"] as const) {
      expect(catalogRefreshTasks(kind)).toHaveLength(1);
    }
  });

  test("a credential change re-reads providers, web search keys, usage and an open provider page", () => {
    expect(catalogRefreshTasks("credential")).toHaveLength(4);
  });

  test("a credential change tells an open provider page to read its accounts again", async () => {
    let notified = 0;
    const unsubscribe = subscribeCredentialChanges(() => { notified += 1; });
    try {
      await catalogRefreshTasks("credential")[3]();
    } finally {
      unsubscribe();
    }
    expect(notified).toBe(1);
  });

  test("projects belong to the sync stores, not to the settings lists", () => {
    expect(catalogRefreshTasks("project")).toEqual([]);
  });
});

describe("the usage task on a credential change", () => {
  test("every credential event retires quota work while the previous refresh is pending", async () => {
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const usage = spyOn(useQuotaStore.getState(), "refreshAfterCredentialChange").mockImplementation(() => pending);
    // A failed provider read skips its delayed reread in this quota-only test.
    const providers = spyOn(useConfigStore.getState(), "loadProviders").mockRejectedValue(new Error("provider unavailable"));
    const reloads = new Map([["credential" as const, []]]);
    try {
      const first = refreshStoresForCatalogKinds(reloads);
      const second = refreshStoresForCatalogKinds(reloads);
      expect(usage).toHaveBeenCalledTimes(2);
      release();
      await Promise.all([first, second]);
    } finally {
      release();
      for (const spy of [usage, providers]) spy.mockRestore();
    }
  });
  const usageTask = () => catalogRefreshTasks("credential")[2];
  const shown = (ids: string[]) => {
    useQuotaStore.setState({
      // SAFETY: the fixture carries the fields these tests read; the store
      // holds the wider `ProviderResult` shape and never inspects the rest.
      results: ids.map((providerId) => ({
        providerId, providerName: providerId, ok: true, configured: true, usage: null, fetchedAt: 1,
      })) as ReturnType<typeof useQuotaStore.getState>["results"],
    });
  };

  beforeEach(() => {
    useQuotaStore.setState({
      results: [],
      // The instance-level load flag stays null on runtimes that never call
      // `ensureLoadedForRuntime`, which is exactly how the VS Code layout loads.
      loadedRuntimeKey: null,
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
    });
  });

  test("cached trackers without a visible readout are invalidated without fetching", async () => {
    const asked: string[][] = [];
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async (ids: string[]) => { asked.push(ids); return true; }) as never,
    });
    shown(["ollama-cloud"]);

    await usageTask()();

    expect(asked).toEqual([]);
    expect(useQuotaStore.getState().results).toEqual([]);
  });

  test("a saved provider selection does not create visible demand", async () => {
    const asked: string[][] = [];
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async (ids: string[]) => { asked.push(ids); return true; }) as never,
    });
    shown(["ollama-cloud", "claude"]);
    useQuotaStore.setState({ dropdownProviderIds: ["ollama-cloud"] });

    await usageTask()();

    expect(asked).toEqual([]);
  });

  test("asks nothing when no tracker has been fetched yet", async () => {
    let called = false;
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async () => { called = true; return true; }) as never,
    });

    await usageTask()();

    // Nothing is on screen to update, and the provider list is still its
    // default of every tracker rather than the user's selection.
    expect(called).toBe(false);
  });

  test("a hidden switch drops the previous account's sample and loaded marker", async () => {
    let invalidate: boolean | undefined;
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async (_ids: string[], options?: { invalidate?: boolean }) => {
        invalidate = options?.invalidate;
        return true;
      }) as never,
    });
    shown(["ollama-cloud"]);
    useQuotaStore.setState({ loadedRuntimeKey: 'local', lastUpdated: 123 });

    await usageTask()();

    expect(invalidate).toBeUndefined();
    expect(useQuotaStore.getState().results).toEqual([]);
    expect(useQuotaStore.getState().loadedRuntimeKey).toBeNull();
    expect(useQuotaStore.getState().lastUpdated).toBeNull();
  });
});
