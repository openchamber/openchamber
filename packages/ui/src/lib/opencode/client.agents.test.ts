import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AgentV2Fixture = {
  id: string;
  description?: string;
  mode: 'subagent' | 'primary' | 'all';
  hidden: boolean;
  system?: string;
  color?: string;
  steps?: number;
  model?: { id: string; providerID: string; variant?: string };
  permissions: Array<{ action: string; resource: string; effect: string }>;
};

const agentListMock = mock((args?: { location?: { directory?: string; workspace?: string } }) => {
  return new Promise<unknown>((resolve, reject) => {
    pendingResolutions.push((r: AgentListTestResponse) => {
      if (r.kind === 'throw') {
        reject(new Error('network down'));
      } else if (r.kind === 'ok') {
        resolve(makeSuccessResult(r.agents));
      } else if (r.kind === 'empty') {
        resolve(makeSuccessResult([]));
      } else if (r.kind === 'malformed') {
        resolve(makeMalformedResult());
      } else {
        const status = r.kind === 'client-error' ? 404 : 500;
        resolve(makeErrorResult(status));
      }
    });
    pendingArgs.push(args);
  });
});

type AgentListTestResponse =
  | { kind: 'ok'; agents: AgentV2Fixture[] }
  | { kind: 'empty' }
  | { kind: 'malformed' }
  | { kind: 'client-error' }
  | { kind: 'server-error' }
  | { kind: 'throw' };

const pendingResolutions: Array<(r: AgentListTestResponse) => void> = [];
const pendingArgs: Array<{ location?: { directory?: string; workspace?: string } } | undefined> = [];

/**
 * Build a HeyApi success result for V2 agent.list. The 200 envelope is
 * `{ location, data: AgentV2Info[] }`; the SDK exposes this whole envelope
 * as `response.data` and the array lives at `response.data.data`.
 */
const makeSuccessResult = (agents: AgentV2Fixture[]) => ({
  data: {
    location: { directory: '/workspace/project' },
    data: agents,
  },
  error: undefined,
  request: new Request('http://test/'),
  response: new Response(null, { status: 200 }),
});

/**
 * Build a HeyApi result whose 200 envelope is missing the `data` array.
 * Used to verify the "non-array data" guard.
 */
const makeMalformedResult = () => ({
  data: { location: { directory: '/workspace/project' } },
  error: undefined,
  request: new Request('http://test/'),
  response: new Response(null, { status: 200 }),
});

const makeErrorResult = (status: number) => ({
  data: undefined,
  error: {
    name: status === 404 ? 'NotFoundError' : 'ServerError',
    data: { message: 'boom' },
  },
  request: new Request('http://test/'),
  response: new Response(null, { status }),
});

const createOpencodeClientMock = mock(() => ({
  v2: {
    agent: {
      list: agentListMock,
    },
  },
}));

(mock as unknown as { restore?: () => void }).restore?.();

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test-agents=${Date.now()}`);

/**
 * Drive the in-flight mocked `list()` call to the next resolver with the
 * given response shape. Each test owns exactly one queued call, so this
 * is unambiguous as long as tests do not overlap.
 */
const resolveNext = (response: AgentListTestResponse) => {
  queueMicrotask(() => {
    const resolver = pendingResolutions.shift();
    if (resolver) resolver(response);
  });
};

const sampleAgent: AgentV2Fixture = {
  id: 'build',
  description: 'Build agent',
  mode: 'primary',
  hidden: false,
  system: 'You are a build agent.',
  color: '#ff00aa',
  steps: 5,
  model: { id: 'claude-opus-4-5', providerID: 'anthropic' },
  permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
};

beforeEach(() => {
  pendingResolutions.length = 0;
  pendingArgs.length = 0;
  opencodeClient.currentDirectory = undefined;
});

describe('opencodeClient.listAgents', () => {
  test('V2 200 success returns mapped Agent[] with V1 field names', async () => {
    const promise = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'ok', agents: [sampleAgent] });
    const result = await promise;
    expect(result).toHaveLength(1);
    const mapped = result[0];
    // Direct field mappings
    expect(mapped.name).toBe(sampleAgent.id);
    expect(mapped.description).toBe(sampleAgent.description);
    expect(mapped.mode).toBe(sampleAgent.mode);
    expect(mapped.hidden).toBe(sampleAgent.hidden);
    expect(mapped.color).toBe(sampleAgent.color);
    expect(mapped.prompt).toBe(sampleAgent.system);
    expect(mapped.steps).toBe(sampleAgent.steps);
    // Body-derived (sample.request.body is {} so temperature/topP/options are empty)
    expect(mapped.options).toEqual({});
    expect(mapped.topP).toBe(undefined);
    expect(mapped.temperature).toBe(undefined);
    expect(mapped.variant).toBe(undefined);
    // Derived: 'build' is a stock built-in ID (AgentV2.defaultID)
    expect(mapped.native).toBe(true);
    // Model ref mapping (V2 ModelRef.id/providerID -> V1 Agent.model.modelID/providerID)
    expect(mapped.model).toEqual({
      modelID: sampleAgent.model!.id,
      providerID: sampleAgent.model!.providerID,
    });
    // Permission: V2 {action,resource,effect} -> V1-shaped {permission,pattern,action}
    // (structural equality; NOT reference equality with V2 input array).
    expect(mapped.permission).toEqual([
      { permission: 'edit', pattern: '*', action: 'allow' },
    ]);
    expect(pendingArgs).toEqual([
      { location: { directory: '/workspace/project' } },
    ]);
  });

  test('V2 200 with empty data throws (NOT silently empty success)', async () => {
    const promise = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'empty' });
    await expect(promise).rejects.toThrow(/agent\.list failed: empty response/);
  });

  test('V2 200 with malformed payload (data missing) throws explicit "invalid response" error', async () => {
    const promise = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'malformed' });
    await expect(promise).rejects.toThrow('agent.list failed: invalid response (non-array data)');
  });

  test('V2 4xx with error payload throws with status code; no V1 resend', async () => {
    const promise = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'client-error' });
    await expect(promise).rejects.toThrow(/agent\.list failed \(404\)/);
    // Confirm only the V2 call was made; the V1 app.agents path is gone.
    expect(pendingArgs).toHaveLength(1);
  });

  test('V2 5xx with error payload throws with status code', async () => {
    const promise = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'server-error' });
    await expect(promise).rejects.toThrow(/agent\.list failed \(500\)/);
  });

  test('Network/transport error (rejected promise) throws transient error', async () => {
    const promise = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'throw' });
    await expect(promise).rejects.toThrow('network down');
  });

  test('listAgentsInFlight dedup: 2 concurrent calls for same directory share one V2 request', async () => {
    const p1 = opencodeClient.listAgents('/workspace/project');
    const p2 = opencodeClient.listAgents('/workspace/project');
    // Only one underlying V2 call should have been queued so far.
    expect(pendingResolutions).toHaveLength(1);
    resolveNext({ kind: 'ok', agents: [sampleAgent] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(pendingArgs).toHaveLength(1);
    expect(pendingArgs[0]).toEqual({
      location: { directory: '/workspace/project' },
    });
  });

  test('listAgentsInFlight cleanup after error (Map is not poisoned)', async () => {
    const failing = opencodeClient.listAgents('/workspace/project');
    resolveNext({ kind: 'server-error' });
    await expect(failing).rejects.toThrow(/agent\.list failed \(500\)/);

    // After the failure the dedup Map must be cleared so a fresh call
    // re-issues the underlying V2 request rather than returning the
    // rejected promise forever.
    const recovered = opencodeClient.listAgents('/workspace/project');
    expect(pendingResolutions).toHaveLength(1);
    resolveNext({ kind: 'ok', agents: [sampleAgent] });
    const result = await recovered;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(sampleAgent.id);
    expect(pendingArgs).toHaveLength(2);
  });

  test('effectiveDirectory: null input + currentDirectory set uses currentDirectory; dedup key matches across normalization variants', async () => {
    opencodeClient.currentDirectory = 'D:/workspace/project';
    // Whitespace/case variants must normalize to the same dedup key as the
    // canonical currentDirectory form.
    const p1 = opencodeClient.listAgents(null);
    const p2 = opencodeClient.listAgents('  d:/workspace/project  ');
    expect(pendingResolutions).toHaveLength(1);
    resolveNext({ kind: 'ok', agents: [sampleAgent] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(pendingArgs).toHaveLength(1);
    expect(pendingArgs[0]).toEqual({
      location: { directory: 'D:/workspace/project' },
    });
  });

  // ----------------------------------------------------------------------
  // Consumer-semantic regression tests (added in corrective rewrite).
  //
  // Each test verifies that the DTO mapping preserves the exact field
  // shape the production consumer reads. The previous implementation
  // used `as unknown as Agent['permission']` which left V2-shaped
  // {action, resource, effect} rules in place -- every consumer that
  // reads rule.permission / rule.pattern then saw undefined, which made
  // permissionUtils.getAgentDefaultEditPermission silently return 'ask'
  // for every agent and broke buildAgentsSignature cache stability.
  // ----------------------------------------------------------------------

  // (A) Permission rule field rename preserves consumer field names.
  test("V2 permissions field-rename produces V1-shaped rules that consumers can read directly", async () => {
    const agentWithRules: AgentV2Fixture = {
      id: "build",
      mode: "primary",
      hidden: false,
      system: "sys",
      permissions: [
        { action: "edit", resource: "*", effect: "allow" },
        { action: "*", resource: "*", effect: "deny" },
      ],
    };
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithRules] });
    const [mapped] = await promise;
    // Field names must be the V1-shaped ones -- not the V2 wire names.
    expect(mapped.permission).toHaveLength(2);
    expect(mapped.permission[0]).toEqual({ permission: "edit", pattern: "*", action: "allow" });
    expect(mapped.permission[1]).toEqual({ permission: "*", pattern: "*", action: "deny" });
    // Consumers reading V1-shaped fields must see strings, not undefined.
    expect(mapped.permission[0].permission).toBe("edit");
    expect(mapped.permission[0].pattern).toBe("*");
    expect(mapped.permission[0].action).toBe("allow");
    expect(mapped.permission[1].permission).toBe("*");
    expect(mapped.permission[1].pattern).toBe("*");
    expect(mapped.permission[1].action).toBe("deny");
  });

  // (B) temperature/topP from request.body produce cache-stable mapping.
  test("V2 temperature/topP in request.body map to V1 agent.temperature/agent.topP", async () => {
    const agentWithBody = {
      id: "build",
      mode: "primary" as const,
      hidden: false,
      permissions: [] as Array<{ action: string; resource: string; effect: string }>,
      request: { headers: {}, body: { temperature: 0.7, top_p: 0.9, foo: "bar" } },
    } as unknown as AgentV2Fixture;
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithBody] });
    const [mapped] = await promise;
    expect(mapped.temperature).toBe(0.7);
    expect(mapped.topP).toBe(0.9);
    // options is the original opaque bag MINUS the reserved keys that
    // stock V1->V2 migration splices into body (temperature, top_p).
    // Those reserved keys live at the top level (agent.temperature /
    // agent.topP) and must NOT be duplicated inside options.
    expect(mapped.options).toEqual({ foo: "bar" });
    // buildAgentsSignature-equivalent concatenation must differ from
    // the previous implementation (which dropped these fields).
    const signatureWithMapped = "t=" + String(mapped.temperature) + "|top_p=" + String(mapped.topP);
    const signatureWithUndefined = "t=undefined|top_p=undefined";
    expect(signatureWithMapped).not.toBe(signatureWithUndefined);
    expect(signatureWithMapped).toBe("t=0.7|top_p=0.9");
  });

  // (C) model.variant maps to V1 agent.variant (NOT undefined).
  test("V2 model.variant maps to V1 agent.variant", async () => {
    const agentWithVariant: AgentV2Fixture = {
      id: "build",
      mode: "primary",
      hidden: false,
      permissions: [],
      model: { id: "claude-opus-4-5", providerID: "anthropic", variant: "max" },
    };
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithVariant] });
    const [mapped] = await promise;
    expect(mapped.model).toEqual({ modelID: "claude-opus-4-5", providerID: "anthropic" });
    expect(mapped.variant).toBe("max");
    expect(mapped.variant).not.toBe(undefined);
  });

  // (D) request.body maps to V1 agent.options MINUS reserved keys
  // (temperature, top_p). Stock V1->V2 migration composes
  // body = {...options, temperature, top_p}; the inverse must strip
  // those reserved keys so agent.temperature / agent.topP at the top
  // level are not duplicated inside options, and so the original
  // opaque options bag is preserved.
  test("V2 request.body maps to V1 agent.options minus reserved keys (temperature, top_p)", async () => {
    const originalBody = { temperature: 0.5, top_p: 0.9, foo: "bar", baz: 42 };
    const agentWithBody = {
      id: "build",
      mode: "primary" as const,
      hidden: false,
      permissions: [] as Array<{ action: string; resource: string; effect: string }>,
      request: { headers: {}, body: originalBody },
    } as unknown as AgentV2Fixture;
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithBody] });
    const [mapped] = await promise;
    // Top-level fields carry the reserved values, NOT options.
    expect(mapped.temperature).toBe(0.5);
    expect(mapped.topP).toBe(0.9);
    // options holds the user's original opaque bag with reserved keys removed.
    expect(mapped.options).toEqual({ foo: "bar", baz: 42 });
    // The original body object is NOT mutated (no `delete` on input).
    expect(originalBody).toEqual({ temperature: 0.5, top_p: 0.9, foo: "bar", baz: 42 });
    expect(Object.prototype.hasOwnProperty.call(originalBody, "temperature")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(originalBody, "top_p")).toBe(true);
  });

  // (E) Built-in detection for all 7 stock built-in IDs.
  test("V2 built-in agents (build/plan/general/explore/compaction/title/summary) produce native=true", async () => {
    const builtIns: AgentV2Fixture[] = [
      "build", "plan", "general", "explore", "compaction", "title", "summary",
    ].map((id) => ({
      id,
      mode: "primary" as const,
      hidden: false,
      permissions: [],
    }));
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: builtIns });
    const result = await promise;
    expect(result).toHaveLength(7);
    for (const agent of result) {
      expect(agent.native).toBe(true);
    }
    expect(result.map((a: { name?: string }) => a.name)).toEqual([
      "build", "plan", "general", "explore", "compaction", "title", "summary",
    ]);
  });

  test("V2 user-defined agent with non-built-in ID produces native=false", async () => {
    const custom: AgentV2Fixture = {
      id: "my-custom-agent",
      mode: "primary",
      hidden: false,
      permissions: [],
    };
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [custom] });
    const [mapped] = await promise;
    expect(mapped.native).toBe(false);
  });

  // (F) End-to-end: the exact regression scenario.
  test("V2 agent with edit-allow rule -> consumers read rule.permission='edit' / rule.pattern='*' / rule.action='allow'", async () => {
    const agentWithEditRule: AgentV2Fixture = {
      id: "build",
      mode: "primary",
      hidden: false,
      permissions: [
        { action: "edit", resource: "*", effect: "allow" },
      ],
    };
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithEditRule] });
    const [mapped] = await promise;

    // Inline the resolvePermissionAction lookup logic so the test exercises
    // the exact regression without coupling to permissionUtils module mocks.
    let resultForEdit: "allow" | "deny" | "ask" | undefined;
    for (const rule of mapped.permission) {
      if (rule.permission === "edit" && rule.pattern === "*") {
        resultForEdit = rule.action;
        break;
      }
    }
    // The previous "as unknown as" implementation would produce a V2-shaped
    // rule where rule.permission is undefined; the lookup above would never
    // match. The corrected mapping must restore the V1 semantics.
    expect(resultForEdit).toBe("allow");
  });

  // (G) Non-wildcard resource patterns are preserved (not collapsed to "*").
  test("V2 permissions with non-wildcard resource preserve the pattern after mapping", async () => {
    const agentWithPaths: AgentV2Fixture = {
      id: "build",
      mode: "primary",
      hidden: false,
      permissions: [
        { action: "edit", resource: "/etc/passwd", effect: "deny" },
        { action: "edit", resource: "*", effect: "allow" },
      ],
    };
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithPaths] });
    const [mapped] = await promise;
    expect(mapped.permission).toHaveLength(2);
    expect(mapped.permission[0].pattern).toBe("/etc/passwd");
    expect(mapped.permission[0].permission).toBe("edit");
    expect(mapped.permission[0].action).toBe("deny");
    expect(mapped.permission[1].pattern).toBe("*");
    expect(mapped.permission[1].permission).toBe("edit");
    expect(mapped.permission[1].action).toBe("allow");
    const patterns = mapped.permission.map((r: { pattern?: string }) => r.pattern);
    expect(patterns).toEqual(["/etc/passwd", "*"]);
  });

  // (H) Malformed V2 permission entries are a payload violation and THROW.
  // Silent drop would let allow / deny / ask decisions drift without
  // detection (downstream consumers like resolvePermissionAction compare
  // rule.permission === 'edit', which never matches undefined and
  // silently degrades every permission check to 'ask'). The throw
  // propagates through listAgents so the caller preserves its existing
  // cache and retries on the next invocation; the listAgentsInFlight
  // dedup Map is NOT poisoned by the throw.

  test("V2 permissions with malformed action throw (NOT silently dropped) -- preserves caller cache for retry", async () => {
    // Given: V2 returns a rule with action=42 (not a string).
    const agentWithBadAction = {
      id: "build",
      mode: "primary" as const,
      hidden: false,
      permissions: [
        { action: "edit", resource: "*", effect: "allow" },
        { action: 42, resource: "*", effect: "deny" }, // malformed: action is a number
      ],
    } as unknown as AgentV2Fixture;
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithBadAction] });
    // When: listAgents() is called.
    // Then: throws with the exact payload-violation message naming the
    // bad field. The message propagates from the mapping helper up
    // through listAgents -- listAgents must NOT swallow it.
    await expect(promise).rejects.toThrow(
      "agent.list failed: malformed permission rule (action=42)",
    );

    // The listAgentsInFlight Map must be cleared after the throw so a
    // subsequent call with valid data re-issues the request and
    // succeeds (cache-preservation invariant: failures do not poison
    // the dedup Map).
    const recovered = opencodeClient.listAgents("/workspace/project");
    expect(pendingResolutions).toHaveLength(1);
    resolveNext({ kind: "ok", agents: [sampleAgent] });
    const result = await recovered;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(sampleAgent.id);
    expect(pendingArgs).toHaveLength(2);
  });

  test("V2 permissions with malformed resource throw (NOT silently dropped)", async () => {
    // Given: V2 returns a rule with action='edit' (string) but
    // resource=null (not a string).
    const agentWithBadResource = {
      id: "build",
      mode: "primary" as const,
      hidden: false,
      permissions: [
        { action: "edit", resource: null, effect: "allow" }, // malformed: resource is null
      ],
    } as unknown as AgentV2Fixture;
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithBadResource] });
    await expect(promise).rejects.toThrow(
      "agent.list failed: malformed permission rule (resource=null)",
    );

    // listAgentsInFlight is NOT poisoned: subsequent valid call works.
    const recovered = opencodeClient.listAgents("/workspace/project");
    expect(pendingResolutions).toHaveLength(1);
    resolveNext({ kind: "ok", agents: [sampleAgent] });
    const result = await recovered;
    expect(result[0].name).toBe(sampleAgent.id);
  });

  test("V2 permissions with unknown effect throw (NOT silently dropped)", async () => {
    // Given: V2 returns a rule with effect='maybe' (not in the
    // allow | deny | ask union enforced by the V2 schema).
    const agentWithBadEffect = {
      id: "build",
      mode: "primary" as const,
      hidden: false,
      permissions: [
        { action: "edit", resource: "*", effect: "maybe" }, // malformed: effect outside union
      ],
    } as unknown as AgentV2Fixture;
    const promise = opencodeClient.listAgents("/workspace/project");
    resolveNext({ kind: "ok", agents: [agentWithBadEffect] });
    await expect(promise).rejects.toThrow(
      "agent.list failed: malformed permission rule (effect=maybe)",
    );

    // listAgentsInFlight is NOT poisoned: subsequent valid call works.
    const recovered = opencodeClient.listAgents("/workspace/project");
    expect(pendingResolutions).toHaveLength(1);
    resolveNext({ kind: "ok", agents: [sampleAgent] });
    const result = await recovered;
    expect(result[0].name).toBe(sampleAgent.id);
  });

});
