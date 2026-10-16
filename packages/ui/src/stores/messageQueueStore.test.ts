import { beforeEach, describe, expect, mock, test } from "bun:test"

// The local queue is the VS Code behavior; every other runtime hands the
// queue to the server (see messageQueueStore.server.test.ts).
const desktop = await import("@/lib/desktop")
mock.module("@/lib/desktop", () => ({ ...desktop, isVSCodeRuntime: () => true }))

const {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  parseMessageQueueKey,
  useMessageQueueStore,
} = await import("./messageQueueStore")
const { useSkillsStore, withoutSwitchedOffQueuedSkills } = await import("./useSkillsStore")
const { buildQueuedAutoSendPayload } = await import("@/hooks/useQueuedMessageAutoSend")
const { buildComposerContext, buildOutgoingMessage } = await import("@/components/chat/composer/submit/buildOutgoingMessage")
const { buildSkillMentionInstruction } = await import("@/lib/skillMentionInstruction")

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

    expect(useMessageQueueStore.getState().getQueueForTarget(a)[0]?.content).toBe("from A")
    expect(useMessageQueueStore.getState().getQueueForTarget(b)[0]?.content).toBe("from B")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.[0]?.content).toBe("legacy")
  })

  test("keeps what was captured at queue time on the local message", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const context = [{ kind: "synthetic" as const, text: "conflict payload" }]
    useMessageQueueStore.getState().addToQueue(target, {
      content: "@Builder do it",
      text: "do it",
      agentMention: "Builder",
      context,
    })
    useMessageQueueStore.getState().addToQueue(target, { content: "plain" })

    const [captured, plain] = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(captured?.content).toBe("@Builder do it")
    expect(captured?.text).toBe("do it")
    expect(captured?.agentMention).toBe("Builder")
    expect(captured?.context).toEqual(context)
    expect(plain?.text).toBe("plain")
    expect(plain?.agentMention).toBe(undefined)
    expect(plain?.context).toBe(undefined)
  })

  test("messages persisted before delivery text existed deliver their content", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "runtime-a\n/repo\nsession-1": [{ id: "queued-1", content: "@Builder old", createdAt: 1 }],
      },
    }, 2)

    expect(migrated.queuedMessages?.["runtime-a\n/repo\nsession-1"]?.[0]?.text).toBe("@Builder old")
  })

  test("bounds each queue to the newest 20 messages", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 25; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.content).toBe("message-5")
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    useMessageQueueStore.getState().markSending(target, first.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(1)
    expect(sendable[0]?.content).toBe("second")

    useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().markSending(target, inFlight.id)

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })
})

describe("queued skill instructions at delivery", () => {
  // Two ids share the display name "deploy".
  const skill = (id: string, name: string) => ({ id, name, path: `/repo/.agents/skills/${id}/SKILL.md`, scope: "project" as const, source: "agents" as const })
  const installed = [skill("deploy-web", "deploy"), skill("deploy-api", "deploy"), skill("code-audit", "audit")]
  const entry = (effective: "enabled" | "disabled" | "unknown") => ({
    disabledIn: { global: effective === "disabled", project: false },
    effective,
    decidedBy: effective === "disabled" ? { path: "/config/opencode.json", resource: "skill:x", effect: "deny" as const, scope: "global" as const, owned: true } : null,
  })
  const effectiveOf = (id: string, off: readonly string[], unknown: readonly string[]) => {
    if (unknown.includes(id)) return "unknown" as const
    return off.includes(id) ? "disabled" as const : "enabled" as const
  }
  /** The skills store as a policy read for `directory` left it. */
  const seedPolicy = (directory: string, off: readonly string[], unknown: readonly string[] = []) => {
    const state = useSkillsStore.getState()
    useSkillsStore.setState({
      skillsByDirectory: { ...state.skillsByDirectory, [directory]: installed },
      availableSkillsByDirectory: { ...state.availableSkillsByDirectory, [directory]: installed.filter((s) => !off.includes(s.id)) },
      policyByDirectory: {
        ...state.policyByDirectory,
        [directory]: {
          error: null,
          state: {
            version: "2.0.29",
            location: "policies",
            writable: true,
            effectiveAvailable: true,
            scopes: { global: { path: "/config/opencode.json", error: null }, project: null },
            skills: new Map(installed.map((s) => [s.id, entry(effectiveOf(s.id, off, unknown))])),
          },
        },
      },
    })
  }
  const mentioned = [{ id: "deploy-api", name: "deploy-api" }, { id: "code-audit", name: "audit" }]
  const instructionFor = (skills: typeof mentioned) => buildSkillMentionInstruction(skills.map((s) => s.name))
  const noComposerContext = { inlineComments: [], syntheticTexts: ["conflict payload"], references: [] }
  const queueWithSkills = (target: NonNullable<ReturnType<typeof createMessageQueueTarget>>) => {
    useMessageQueueStore.getState().addToQueue(target, {
      content: "ship it with $deploy-api and $audit",
      context: buildComposerContext(noComposerContext, { text: instructionFor(mentioned) ?? "", skills: mentioned }),
    })
  }

  beforeEach(() => {
    useSkillsStore.setState({ skillsByDirectory: {}, availableSkillsByDirectory: {}, policyByDirectory: {}, lastDecidedByDirectory: {} })
  })

  test("a skill last seen off stays out of auto-send and the composer's send while the policy reads unknown", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    seedPolicy("/repo", [])
    queueWithSkills(target)
    // The latest read could not decide deploy-api (an unparsable scope file);
    // the read before it said off. useSkillsStore.test.ts covers how the store gets here.
    seedPolicy("/repo", [], ["deploy-api"])
    useSkillsStore.setState({ lastDecidedByDirectory: { "/repo": new Map([["deploy-api", "disabled"], ["code-audit", "enabled"]]) } })
    const onlyAudit = { text: instructionFor([mentioned[1]]), synthetic: true }

    const payload = buildQueuedAutoSendPayload(useMessageQueueStore.getState().getSendableQueue(target), target.directory)
    expect(payload?.additionalParts).toEqual([{ text: "conflict payload", synthetic: true }, onlyAudit])

    const [taken] = await useMessageQueueStore.getState().takeForSend(target)
    expect(withoutSwitchedOffQueuedSkills(taken?.context ?? [], target.directory)).toEqual([
      { kind: "synthetic", text: "conflict payload" },
      { kind: "instruction", text: onlyAudit.text, skills: [mentioned[1]] },
    ])
  })

  test("auto-send leaves out a skill switched off while the message waited, and keeps it after re-enable", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    seedPolicy("/repo", [])
    queueWithSkills(target)
    seedPolicy("/repo", ["deploy-api"])

    const payload = buildQueuedAutoSendPayload(useMessageQueueStore.getState().getSendableQueue(target), target.directory)
    expect(payload?.primaryText).toBe("ship it with $deploy-api and $audit")
    expect(payload?.additionalParts).toEqual([
      { text: "conflict payload", synthetic: true },
      { text: instructionFor([mentioned[1]]), synthetic: true },
    ])

    seedPolicy("/repo", [])
    const enabled = buildQueuedAutoSendPayload(useMessageQueueStore.getState().getSendableQueue(target), target.directory)
    expect(enabled?.additionalParts[1]).toEqual({ text: instructionFor(mentioned), synthetic: true })
  })

  test("the composer's own send of a taken message drops an instruction naming only switched-off skills", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    seedPolicy("/repo", [])
    queueWithSkills(target)
    seedPolicy("/repo", ["deploy-api", "code-audit"])

    const taken = await useMessageQueueStore.getState().takeForSend(target)
    // What ChatInput hands to assembly.
    const outgoing = buildOutgoingMessage({
      ...noComposerContext,
      syntheticTexts: [],
      queued: taken.map((queued) => ({ ...queued, context: withoutSwitchedOffQueuedSkills(queued.context ?? [], target.directory) })),
      composerText: null,
      composerAttachments: [],
    }, {
      parseAgentMention: (text) => ({ text }),
      extractFileMentions: (text) => ({ text, attachments: [] }),
      sanitizeAttachments: (files) => [...(files ?? [])],
      collectSkillNames: () => [],
    })
    expect(outgoing.primaryText).toBe("ship it with $deploy-api and $audit")
    expect(outgoing.additionalParts).toEqual([{ text: "conflict payload", synthetic: true }])
  })

  test("a switch in another directory, or no policy read at all, leaves the instruction as queued", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    queueWithSkills(target)
    const context = useMessageQueueStore.getState().getQueueForTarget(target)[0]?.context ?? []
    expect(withoutSwitchedOffQueuedSkills(context, "/repo")).toEqual(context)

    seedPolicy("/other", ["deploy-api", "code-audit"])
    seedPolicy("/repo", [])
    expect(withoutSwitchedOffQueuedSkills(context, "/repo")).toEqual(context)
  })

  test("an instruction stored without ids (server take, older queue) is checked by its names", () => {
    seedPolicy("/repo", ["deploy-api"])
    // `deploy` is shared, but only deploy-web is available: it stays named.
    const legacy = [
      { kind: "instruction" as const, text: buildSkillMentionInstruction(["deploy", "deploy-api", "audit"]) ?? "" },
      { kind: "instruction" as const, text: "Text this build did not write" },
    ]
    expect(withoutSwitchedOffQueuedSkills(legacy, "/repo")).toEqual([
      { kind: "instruction", text: buildSkillMentionInstruction(["deploy", "audit"]) ?? "" },
      { kind: "instruction", text: "Text this build did not write" },
    ])
  })
})
