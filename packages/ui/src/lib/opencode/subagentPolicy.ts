/**
 * State logic for the "Subsession models" picker.
 *
 * The picker edits only exact model refs (`provider/model`). A policy can
 * also hold wider selectors (`provider/*`, `provider/model#variant`) set
 * through config or the API: those stay in the list as read-only entries and
 * are preserved verbatim on every save, and `excludedModels` and
 * `agentOverrides` are preserved exactly as loaded.
 */

import type { SubagentPolicy } from "./model"

/** An exact ref names one model with any variant: no wildcard, no `#variant`. */
export function isExactModelRef(selector: string): boolean {
  return !selector.includes("*") && !selector.includes("#")
}

/** The two kinds of `models` entries the picker shows. */
export type SubagentPolicyModels = {
  exact: string[]
  readOnly: string[]
}

export function splitSubagentPolicyModels(policy: SubagentPolicy | undefined): SubagentPolicyModels {
  const exact: string[] = []
  const readOnly: string[] = []
  for (const selector of policy?.models ?? []) {
    if (isExactModelRef(selector)) exact.push(selector)
    else readOnly.push(selector)
  }
  return { exact, readOnly }
}

/**
 * The policy after toggling one exact ref. Read-only entries keep their
 * places, an unchecked ref is removed, a checked ref is appended, and the
 * rest of the policy is carried over unchanged.
 */
export function toggleSubagentModel(
  policy: SubagentPolicy | undefined,
  ref: string,
  checked: boolean,
): SubagentPolicy {
  const current = policy?.models ?? []
  const models = checked
    ? (current.includes(ref) ? [...current] : [...current, ref])
    : current.filter((entry) => entry !== ref)
  return {
    ...policy,
    models,
  }
}

/** The policy a session is created with, or `undefined` when nothing was checked. */
export function subagentPolicyForCreate(selectedRefs: readonly string[]): SubagentPolicy | undefined {
  if (selectedRefs.length === 0) return undefined
  return { models: [...selectedRefs] }
}

export interface SubagentPolicyWriter {
  /**
   * Toggles one exact ref on top of the newest policy: the last one asked for
   * while writes are pending, else `saved`. The write is queued behind any
   * earlier one, so writes reach the server in the order they were made.
   */
  toggle(saved: SubagentPolicy | undefined, ref: string, checked: boolean): void
}

/**
 * Saves picker toggles one after another, so several can be made in a row
 * without waiting for each to settle. Each write sends the whole policy with
 * every earlier toggle applied, so the last write holds every change.
 *
 * `onPendingChange` reports the policy to show while writes are in flight and
 * `null` once the last one settles, when the saved session record is again
 * the source of truth. A failed write is reported through `onError` and the
 * queue carries on with the writes behind it.
 */
export function createSubagentPolicyWriter(options: {
  write: (policy: SubagentPolicy) => Promise<void>
  onPendingChange: (pending: SubagentPolicy | null) => void
  onError: (error: Error) => void
}): SubagentPolicyWriter {
  let pending: SubagentPolicy | null = null
  let inFlight = 0
  let queue: Promise<void> = Promise.resolve()
  return {
    toggle(saved, ref, checked) {
      const next = toggleSubagentModel(pending ?? saved, ref, checked)
      pending = next
      inFlight += 1
      options.onPendingChange(next)
      queue = queue
        .then(() => options.write(next))
        .catch((error) => options.onError(error instanceof Error ? error : new Error(String(error))))
        .then(() => {
          inFlight -= 1
          if (inFlight > 0) return
          pending = null
          options.onPendingChange(null)
        })
    },
  }
}
