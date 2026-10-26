import assert from "node:assert/strict"
import { test } from "node:test"

import { buildRenderProbeSource, RENDER_PROBE_GLOBAL, summarizeRenderProbe } from "./render-probe.mjs"

const element = (selector) => ({ nodeType: 1, closest: (query) => (query === selector ? {} : null) })

// A fresh page each time: the probe installs itself once per page.
const installProbe = () => {
  delete globalThis[RENDER_PROBE_GLOBAL]
  globalThis.document = { documentElement: {} }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  new Function(buildRenderProbeSource())()
  return { hook: globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__, probe: globalThis[RENDER_PROBE_GLOBAL] }
}

test("a render whose subtree wrote nothing to the DOM is counted; one above a DOM write is not", () => {
  const { hook, probe } = installProbe()
  hook.inject({})
  probe.start()
  function Parent() {}
  function Child() {}
  const div = { tag: 5, flags: 0, alternate: { tag: 5 }, memoizedProps: {}, stateNode: element("aside") }
  div.alternate.memoizedProps = div.memoizedProps
  const child = { tag: 0, type: Child, flags: 1, alternate: { memoizedProps: { value: 1 }, child: div }, memoizedProps: { value: 2 }, child: div }
  const text = { tag: 6, flags: 4, alternate: { memoizedProps: "a" }, memoizedProps: "b", stateNode: element('[data-scrollbar="chat"]') }
  child.sibling = text
  const parentProps = { title: "x" }
  const parent = {
    tag: 0, type: Parent, flags: 1, memoizedProps: parentProps, child,
    alternate: { memoizedProps: parentProps, memoizedState: { memoizedState: 1, next: null }, child: {} },
    memoizedState: { memoizedState: 2, queue: {}, next: null },
  }
  hook.onCommitFiberRoot(1, { current: { child: parent, alternate: {} } })
  probe.stop()
  const summary = summarizeRenderProbe(JSON.parse(JSON.stringify(probe.snapshot())))
  const byName = Object.fromEntries(summary.components.map((entry) => [entry.name, entry]))
  assert.equal(byName.Parent.withoutDomChange, 0)
  assert.deepEqual(byName.Parent.cause, { state: 1 })
  assert.equal(byName.Child.withoutDomChange, 1)
  assert.deepEqual(byName.Child.cause, { parent: 1 })
  assert.equal(summary.rendersWithoutDomChangePercent, 50)
})

test("a build without the store probe reports store counts as missing, and a hook React never used as such", () => {
  const { probe } = installProbe()
  probe.start()
  probe.stop()
  const summary = summarizeRenderProbe(JSON.parse(JSON.stringify(probe.snapshot())))
  assert.equal(summary.stores, null)
  assert.equal(summary.storeProbe, false)
  assert.equal(summary.hookInjected, false)
})
