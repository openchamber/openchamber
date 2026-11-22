import { describe, expect, test } from "bun:test"
import {
  createSubagentPolicyWriter,
  isExactModelRef,
  splitSubagentPolicyModels,
  subagentPolicyForCreate,
  toggleSubagentModel,
} from "./subagentPolicy"
import type { SubagentPolicy } from "./model"

describe("isExactModelRef", () => {
  test("accepts a plain provider/model ref", () => {
    expect(isExactModelRef("anthropic/claude-sonnet-5")).toBe(true)
  })

  test("rejects wildcards and variant refs", () => {
    expect(isExactModelRef("opencode-go/*")).toBe(false)
    expect(isExactModelRef("openai/gpt-5.5#high")).toBe(false)
  })

  test("a route-pool ref is an ordinary exact ref", () => {
    expect(isExactModelRef("opencode-route/team-pool")).toBe(true)
  })
})

describe("splitSubagentPolicyModels", () => {
  test("separates exact refs from read-only selectors, keeping order", () => {
    const policy: SubagentPolicy = {
      models: ["opencode-go/*", "anthropic/claude-sonnet-5", "openai/gpt-5.5#high", "openai/gpt-5.4"],
    }
    expect(splitSubagentPolicyModels(policy)).toEqual({
      exact: ["anthropic/claude-sonnet-5", "openai/gpt-5.4"],
      readOnly: ["opencode-go/*", "openai/gpt-5.5#high"],
    })
  })

  test("an absent policy splits to empty lists", () => {
    expect(splitSubagentPolicyModels(undefined)).toEqual({ exact: [], readOnly: [] })
  })
})

describe("toggleSubagentModel", () => {
  const policy: SubagentPolicy = {
    models: ["opencode-go/*", "anthropic/claude-sonnet-5"],
    excludedModels: ["openai/gpt-5"],
    agentOverrides: { build: { models: ["anthropic/claude-sonnet-5"] } },
  }

  test("checking appends the ref and preserves everything else verbatim", () => {
    expect(toggleSubagentModel(policy, "openai/gpt-5.4", true)).toEqual({
      models: ["opencode-go/*", "anthropic/claude-sonnet-5", "openai/gpt-5.4"],
      excludedModels: ["openai/gpt-5"],
      agentOverrides: { build: { models: ["anthropic/claude-sonnet-5"] } },
    })
  })

  test("unchecking removes only that ref; read-only entries keep their place", () => {
    expect(toggleSubagentModel(policy, "anthropic/claude-sonnet-5", false).models)
      .toEqual(["opencode-go/*"])
  })

  test("checking an already-present ref does not duplicate it", () => {
    expect(toggleSubagentModel(policy, "anthropic/claude-sonnet-5", true).models)
      .toEqual(["opencode-go/*", "anthropic/claude-sonnet-5"])
  })

  test("toggling from no policy starts from an empty list", () => {
    expect(toggleSubagentModel(undefined, "openai/gpt-5.4", true))
      .toEqual({ models: ["openai/gpt-5.4"] })
  })
})

describe("subagentPolicyForCreate", () => {
  test("nothing checked means no policy on create", () => {
    expect(subagentPolicyForCreate([])).toBeUndefined()
  })

  test("checked refs become the create policy", () => {
    expect(subagentPolicyForCreate(["openai/gpt-5.4", "anthropic/claude-sonnet-5"]))
      .toEqual({ models: ["openai/gpt-5.4", "anthropic/claude-sonnet-5"] })
  })

  test("route pools are selectable like any other exact ref", () => {
    expect(subagentPolicyForCreate(["opencode-route/team-pool"]))
      .toEqual({ models: ["opencode-route/team-pool"] })
  })
})

describe("createSubagentPolicyWriter", () => {
  type Deferred = { policy: SubagentPolicy; resolve: () => void; reject: (error: Error) => void }

  const setup = () => {
    const writes: Deferred[] = []
    const pendingChanges: Array<SubagentPolicy | null> = []
    const errors: Error[] = []
    const writer = createSubagentPolicyWriter({
      write: (policy) => new Promise<void>((resolve, reject) => { writes.push({ policy, resolve, reject }) }),
      onPendingChange: (pending) => { pendingChanges.push(pending) },
      onError: (error) => { errors.push(error) },
    })
    return { writer, writes, pendingChanges, errors }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("a toggle made while a save is in flight builds on it and waits its turn", async () => {
    const saved: SubagentPolicy = { models: ["opencode-go/*"], excludedModels: ["openai/gpt-5"] }
    const { writer, writes, pendingChanges } = setup()

    writer.toggle(saved, "openai/gpt-5.4", true)
    // The saved record has not caught up yet: the second toggle still starts from it.
    writer.toggle(saved, "anthropic/claude-sonnet-5", true)
    await settle()

    expect(pendingChanges.at(-1)?.models).toEqual(["opencode-go/*", "openai/gpt-5.4", "anthropic/claude-sonnet-5"])
    // Only the first write has started; the second waits for it.
    expect(writes).toHaveLength(1)
    expect(writes[0].policy.models).toEqual(["opencode-go/*", "openai/gpt-5.4"])

    writes[0].resolve()
    await settle()
    expect(writes).toHaveLength(2)
    expect(writes[1].policy).toEqual({
      models: ["opencode-go/*", "openai/gpt-5.4", "anthropic/claude-sonnet-5"],
      excludedModels: ["openai/gpt-5"],
    })
    expect(pendingChanges.at(-1)).not.toBeNull()

    writes[1].resolve()
    await settle()
    expect(pendingChanges.at(-1)).toBeNull()
  })

  test("a failed save is reported, later saves still run, and the pending policy clears", async () => {
    const { writer, writes, pendingChanges, errors } = setup()
    writer.toggle(undefined, "openai/gpt-5.4", true)
    writer.toggle(undefined, "openai/gpt-5.4", false)
    await settle()

    writes[0].reject(new Error("offline"))
    await settle()
    expect(errors).toHaveLength(1)
    expect(writes).toHaveLength(2)
    expect(writes[1].policy.models).toEqual([])

    writes[1].resolve()
    await settle()
    expect(pendingChanges.at(-1)).toBeNull()
  })

  // Oracle: applying the same toggles one by one with toggleSubagentModel.
  test("for any toggle sequence, writes go out in order and the last one holds every change", async () => {
    const refs = ["a/1", "a/2", "b/1", "opencode-route/pool"]
    let seed = 7
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let run = 0; run < 200; run += 1) {
      const saved: SubagentPolicy = { models: ["x/*"], agentOverrides: { build: { models: ["a/1"] } } }
      const { writer, writes, pendingChanges, errors } = setup()
      let expected: SubagentPolicy = saved
      const expectedWrites: SubagentPolicy[] = []
      const count = 1 + Math.floor(random() * 8)
      for (let index = 0; index < count; index += 1) {
        const ref = refs[Math.floor(random() * refs.length)]
        const checked = random() < 0.5
        writer.toggle(saved, ref, checked)
        expected = toggleSubagentModel(expected, ref, checked)
        expectedWrites.push(expected)
      }
      for (let index = 0; index < count; index += 1) {
        await settle()
        expect(writes).toHaveLength(index + 1)
        if (random() < 0.2) writes[index].reject(new Error("failed"))
        else writes[index].resolve()
      }
      await settle()
      expect(writes.map((write) => write.policy)).toEqual(expectedWrites)
      expect(writes.at(-1)?.policy).toEqual(expected)
      expect(pendingChanges.filter((change) => change === null)).toHaveLength(1)
      expect(pendingChanges.at(-1)).toBeNull()
      expect(errors.length).toBeLessThanOrEqual(count)
    }
  })
})
