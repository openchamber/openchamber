/**
 * Scenario setup shared by the idle and streaming profilers.
 *
 * Idle and streaming cost both depend on how much of the sidebar is mounted,
 * so both commands need the same way to reach a heavily populated sidebar.
 * Setup always runs before the measured window.
 */

import { evaluateValue, wait } from "./cdp.mjs"

/**
 * Expands every project. The sidebar persists the ids of collapsed projects,
 * so an empty list expands everything. Requires a reload to take effect.
 */
export const expandProjects = async (client) => {
  await evaluateValue(client, `localStorage.setItem("oc.sessions.projectCollapse", "[]")`)
}

/**
 * Clicks every "Show more sessions" control until none remain.
 *
 * Session list pagination is component state, so unlike project collapse it
 * cannot be seeded through storage. The controls only exist once the sidebar
 * has populated, so call this after the page has settled, never straight after
 * the load event.
 *
 * Matching is a case-insensitive substring test, which assumes the English UI
 * locale; a non-English locale expands nothing and reports zero.
 */
export const expandSessionLists = async (client, { passes = 40, settleMs = 400 } = {}) => {
  let totalClicked = 0
  for (let pass = 0; pass < passes; pass += 1) {
    const clicked = await evaluateValue(client, `(() => {
      const controls = [...document.querySelectorAll("button")]
        .filter((button) => (button.textContent ?? "").toLowerCase().includes("show more"))
      for (const control of controls) control.click()
      return controls.length
    })()`)
    if (!clicked) break
    totalClicked += clicked
    await wait(settleMs)
  }
  return totalClicked
}
