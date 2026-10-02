import { beforeEach, describe, expect, test } from "bun:test";

import { QUOTA_PROVIDERS } from "@/lib/quota/providers";
import { catalogRefreshTasks } from "./catalogRefresh";
import { useQuotaStore } from "./useQuotaStore";

describe("catalogRefreshTasks", () => {
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

  test("a credential change re-reads providers, web search keys and usage", () => {
    expect(catalogRefreshTasks("credential")).toHaveLength(3);
  });

  test("projects belong to the sync stores, not to the settings lists", () => {
    expect(catalogRefreshTasks("project")).toEqual([]);
  });
});

describe("the usage task on a credential change", () => {
  const usageTask = () => catalogRefreshTasks("credential")[2];
  const shown = (ids: string[]) => {
    useQuotaStore.setState({
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

  test("refreshes the shown trackers even when the instance load flag is unset", async () => {
    // The reported bug: switching an account in the extension refreshed
    // nothing, because that runtime never sets `loadedRuntimeKey`.
    const asked: string[][] = [];
    useQuotaStore.setState({
      fetchQuotas: (async (ids: string[]) => { asked.push(ids); return true; }) as never,
    });
    shown(["ollama-cloud"]);

    await usageTask()();

    expect(asked).toEqual([["ollama-cloud"]]);
  });

  test("only the trackers already on screen, never the full default list", async () => {
    const asked: string[][] = [];
    useQuotaStore.setState({
      fetchQuotas: (async (ids: string[]) => { asked.push(ids); return true; }) as never,
    });
    shown(["ollama-cloud", "claude"]);
    useQuotaStore.setState({ dropdownProviderIds: ["ollama-cloud"] });

    await usageTask()();

    expect(asked).toEqual([["ollama-cloud"]]);
  });

  test("asks nothing when no tracker has been fetched yet", async () => {
    let called = false;
    useQuotaStore.setState({
      fetchQuotas: (async () => { called = true; return true; }) as never,
    });

    await usageTask()();

    // Nothing is on screen to update, and the provider list is still its
    // default of every tracker rather than the user's selection.
    expect(called).toBe(false);
  });

  test("a switch invalidates, so the previous account's sample is not kept", async () => {
    let invalidate: boolean | undefined;
    useQuotaStore.setState({
      fetchQuotas: (async (_ids: string[], options?: { invalidate?: boolean }) => {
        invalidate = options?.invalidate;
        return true;
      }) as never,
    });
    shown(["ollama-cloud"]);

    await usageTask()();

    expect(invalidate).toBe(true);
  });
});
