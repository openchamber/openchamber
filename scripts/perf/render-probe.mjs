/**
 * Page-side render attribution: which components re-render, why, and whether
 * a render changed anything in the DOM.
 *
 * `buildRenderProbeSource()` returns a script installed with
 * `Page.addScriptToEvaluateOnNewDocument`, before any application module runs.
 * It records:
 * - React commits, through a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__`: renders
 *   per component, their cause (parent props, own state, store, context),
 *   whether the rendered output changed, the DOM writes React made under each
 *   render, and renders whose whole subtree wrote nothing to the DOM;
 * - store notifications per zustand store, when the page runs the diagnostic
 *   build (`bun run build:web:diag`), which reports them to `__ocStoreProbe`;
 * - DOM mutation records per UI region, from a MutationObserver.
 *
 * The probe adds work of its own on every commit. A run with it is an
 * attribution run: quote its counts, never its timings.
 */

export const RENDER_PROBE_GLOBAL = "__openchamberRenderProbe"

const probeFactory = function installOpenchamberRenderProbe(globalName, traceHook, commitLogLimit) {
  if (globalThis[globalName]) return
  const now = () => performance.now()
  let recording = false
  let startedAt = 0
  let stoppedAt = 0
  let probeMs = 0
  let hookInjected = false

  // UI regions by landmark. Selectors follow the app's DOM; a region that
  // stops matching shows up as growth in "app-other".
  const regionOf = (node) => {
    const element = node && node.nodeType === 1 ? node : node?.parentElement
    if (!element) return "detached"
    if (element.closest("head")) return "head"
    if (element.closest('[data-scrollbar="chat"]')) return "chat-timeline"
    if (element.closest("[data-composer-slot]")) return "composer"
    if (element.closest('aside[aria-label="Work status"]')) return "work-status-panel"
    if (element.closest("header")) return "header"
    if (element.closest('nav[aria-label="Panel surfaces"]')) return "panel-rail"
    if (element.closest("aside")) return "sidebar"
    if (element.closest("main")) return "main-other"
    if (element.closest("#root")) return "app-other"
    return "portal/body"
  }

  // ---------- React commits ----------
  // Fiber flags and tags as of React 18/19.
  const PERFORMED_WORK = 1
  const PLACEMENT = 2
  const UPDATE = 4
  const CHILD_DELETION = 16
  const HOST_COMPONENT = 5
  const HOST_TEXT = 6
  const COMPOSITE = new Set([0, 1, 11, 15])

  const anonymousNames = new Map()
  const anonymousSources = {}
  const anonymousName = (fn, kind) => {
    let name = anonymousNames.get(fn)
    if (!name) {
      name = `${kind}#${anonymousNames.size + 1}`
      anonymousNames.set(fn, name)
      try { anonymousSources[name] = String(fn).slice(0, 300) } catch { anonymousSources[name] = "?" }
    }
    return name
  }
  const nameOf = (fiber) => {
    const type = fiber.type
    if (!type) return null
    const named = (fn) => fn && (fn.displayName || fn.name)
    if (fiber.tag === 15 && !named(type) && !fiber.elementType?.displayName) return anonymousName(type, "Memo")
    if (fiber.tag === 0 && !named(type)) {
      if (fiber.return?.tag === 14 && fiber.return.elementType?.displayName) return fiber.return.elementType.displayName
      return anonymousName(type, "Anonymous")
    }
    if (fiber.tag === 11) return type.displayName || type.render?.displayName || type.render?.name || "ForwardRef"
    if (fiber.tag === 15) return type.displayName || fiber.elementType?.displayName || type.name || "Memo"
    return type.displayName || type.name || "Anonymous"
  }
  const shallowEqual = (left, right) => {
    if (left === right) return true
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => Object.is(left[key], right[key]))
  }
  const describe = (value) => {
    if (value === null) return "null"
    if (Array.isArray(value)) return `array${value.length}`
    if (typeof value === "object") return "object"
    return String(value).slice(0, 30)
  }

  const components = new Map()
  const commits = []
  const origins = {}
  let commit = null
  const component = (name) => {
    let entry = components.get(name)
    if (!entry) {
      entry = {
        name, renders: 0, mounts: 0, rendersWithoutDomChange: 0,
        cause: { parent: 0, parentSameProps: 0, store: 0, state: 0, context: 0, other: 0 },
        output: { identical: 0, equivalent: 0, changed: 0 },
        domUpdates: 0, textUpdates: 0, domPlacements: 0, regions: {}, changedProps: {},
      }
      components.set(name, entry)
    }
    return entry
  }
  const causeOf = (fiber) => {
    const previous = fiber.alternate
    if (fiber.memoizedProps !== previous.memoizedProps) {
      if (shallowEqual(fiber.memoizedProps, previous.memoizedProps)) return ["parentSameProps", null]
      const next = fiber.memoizedProps || {}
      const last = previous.memoizedProps || {}
      const changed = [...new Set([...Object.keys(next), ...Object.keys(last)])].filter((key) => !Object.is(next[key], last[key]))
      return ["parent", changed]
    }
    if (fiber.tag === 1) return fiber.memoizedState !== previous.memoizedState ? ["state", null] : ["other", null]
    let hook = fiber.memoizedState
    let previousHook = previous.memoizedState
    let index = 0
    while (hook && previousHook) {
      if (hook.queue && !Object.is(hook.memoizedState, previousHook.memoizedState)) {
        return [hook.queue.getSnapshot ? "store" : "state", [`hook#${index} ${describe(previousHook.memoizedState)}->${describe(hook.memoizedState)}`]]
      }
      hook = hook.next
      previousHook = previousHook.next
      index += 1
    }
    if (fiber.dependencies) return ["context", null]
    return ["other", null]
  }
  const outputOf = (fiber) => {
    let identical = true
    for (let child = fiber.child; child; child = child.sibling) {
      if (!child.alternate) return "changed"
      if (child.memoizedProps === child.alternate.memoizedProps) continue
      identical = false
      if (typeof child.memoizedProps !== "object" || !shallowEqual(child.memoizedProps, child.alternate.memoizedProps)) return "changed"
    }
    return identical ? "identical" : "equivalent"
  }
  const hostRegion = (fiber) => {
    for (let child = fiber; child; child = child.child) {
      if (child.tag === HOST_COMPONENT || child.tag === HOST_TEXT) return regionOf(child.stateNode)
    }
    return "none"
  }

  // Optional: record who dispatches to one hook ("Component:hookIndex").
  const hookSetters = {}
  const stackSummary = () => String(new Error().stack).split("\n").slice(2, 9)
    .filter((line) => line.includes("http")).map((line) => line.trim().replace(/^at /, "")).join(" <- ")
  const wrapTracedHook = (fiber, name) => {
    if (!traceHook || name !== traceHook.component) return
    let hook = fiber.memoizedState
    for (let index = 0; hook && index < traceHook.index; index += 1) hook = hook.next
    const queue = hook?.queue
    if (!queue || queue.__openchamberTraced || typeof queue.dispatch !== "function") return
    queue.__openchamberTraced = true
    const dispatch = queue.dispatch
    queue.dispatch = function tracedDispatch(...args) {
      if (recording) {
        const action = args[args.length - 1]
        const key = `${typeof action === "function" ? "(fn)" : String(action).slice(0, 20)} :: ${stackSummary()}`
        hookSetters[key] = (hookSetters[key] || 0) + 1
      }
      return dispatch.apply(this, args)
    }
  }

  // Walks the committed tree and returns how many DOM writes it found under
  // `fiber` and its siblings, so each rendered component knows whether its
  // subtree changed anything.
  const walk = (fiber, mounted, owner, origin) => {
    let total = 0
    for (let current = fiber; current; current = current.sibling) {
      const isMount = mounted || current.alternate === null
      let own = 0
      let nextOwner = owner
      let nextOrigin = origin
      let rendered = null
      if (!mounted && current.flags & PLACEMENT) own += 1
      if (!isMount && current.flags & CHILD_DELETION) own += 1
      if (COMPOSITE.has(current.tag)) {
        const name = nameOf(current)
        nextOwner = name
        wrapTracedHook(current, name)
        if (isMount) {
          if (!mounted) { component(name).mounts += 1; commit.mounts += 1 }
        } else if ((current.flags & PERFORMED_WORK) === PERFORMED_WORK) {
          rendered = component(name)
          rendered.renders += 1
          commit.renders += 1
          commit.names[name] = (commit.names[name] || 0) + 1
          const [cause, changed] = causeOf(current)
          rendered.cause[cause] += 1
          if (cause !== "parent" && cause !== "parentSameProps") nextOrigin = `${name}(${cause})`
          const originEntry = origins[nextOrigin || "?"] || (origins[nextOrigin || "?"] = { renders: 0, names: {} })
          originEntry.renders += 1
          originEntry.names[name] = (originEntry.names[name] || 0) + 1
          for (const key of changed ?? []) rendered.changedProps[key] = (rendered.changedProps[key] || 0) + 1
          rendered.output[outputOf(current)] += 1
          const region = hostRegion(current)
          rendered.regions[region] = (rendered.regions[region] || 0) + 1
        }
      } else if (!isMount && (current.tag === HOST_COMPONENT || current.tag === HOST_TEXT) && owner) {
        if (current.flags & UPDATE) {
          own += 1
          const ownerEntry = component(owner)
          if (current.tag === HOST_TEXT) ownerEntry.textUpdates += 1
          else ownerEntry.domUpdates += 1
          commit.domUpdates += 1
          const region = regionOf(current.stateNode)
          commit.regions[region] = (commit.regions[region] || 0) + 1
        }
        if (current.flags & PLACEMENT) component(owner).domPlacements += 1
      }
      const below = isMount || current.child !== current.alternate?.child
        ? walk(current.child, isMount, nextOwner, nextOrigin)
        : 0
      if (rendered && own + below === 0) {
        rendered.rendersWithoutDomChange += 1
        commit.rendersWithoutDomChange += 1
      }
      total += own + below
    }
    return total
  }

  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => { hookInjected = true; return 1 },
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: (_rendererId, root) => {
      if (!recording) return
      const startedCommit = now()
      commit = { t: Math.round(startedCommit - startedAt), renders: 0, mounts: 0, rendersWithoutDomChange: 0, domUpdates: 0, names: {}, regions: {} }
      try {
        const current = root.current
        walk(current.child, current.alternate === null, null, null)
      } catch (error) {
        commit.error = String(error)
      }
      if (commits.length < commitLogLimit) commits.push(commit)
      probeMs += now() - startedCommit
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  }

  // ---------- zustand stores (diagnostic build only) ----------
  const stores = new Map()
  let storeSequence = 0
  const notifyGroups = []
  let notifyGroup = null
  const creationSite = (stack) => String(stack || "").split("\n").slice(1)
    .filter((line) => line.includes("http") && !line.includes("vendor-zustand"))
    .slice(0, 3).map((line) => line.trim().replace(/^at\s+/, ""))
  const emptyStore = (frames) => ({ id: ++storeSequence, frames, notifies: 0, listeners: 0, maxListeners: 0, ms: 0, maxMs: 0, keys: {} })
  globalThis.__ocStoreProbe = {
    get recording() { return recording },
    register(api, stack) { stores.set(api, emptyStore(creationSite(stack))) },
    notify(api, listeners, state, previous) {
      const startedNotify = now()
      listeners.forEach((listener) => listener(state, previous))
      const elapsed = now() - startedNotify
      let store = stores.get(api)
      if (!store) { store = emptyStore(["(unregistered)"]); stores.set(api, store) }
      store.notifies += 1
      store.listeners += listeners.size
      store.maxListeners = Math.max(store.maxListeners, listeners.size)
      store.ms += elapsed
      store.maxMs = Math.max(store.maxMs, elapsed)
      if (state && previous && typeof state === "object" && typeof previous === "object") {
        for (const key in state) if (state[key] !== previous[key]) store.keys[key] = (store.keys[key] || 0) + 1
      }
      // Notifications inside one synchronous task form one group.
      if (!notifyGroup) {
        notifyGroup = { t: Math.round(startedNotify - startedAt), notifies: 0, listeners: 0, ms: 0 }
        if (notifyGroups.length < commitLogLimit) notifyGroups.push(notifyGroup)
        queueMicrotask(() => { notifyGroup = null })
      }
      notifyGroup.notifies += 1
      notifyGroup.listeners += listeners.size
      notifyGroup.ms += elapsed
    },
  }

  // ---------- DOM mutations by region ----------
  const mutations = {}
  const attributeMutations = {}
  let observer = null
  const bump = (region, kind, added = 0, removed = 0) => {
    const entry = mutations[region] || (mutations[region] = { records: 0, childList: 0, attributes: 0, characterData: 0, added: 0, removed: 0 })
    entry.records += 1
    entry[kind] += 1
    entry.added += added
    entry.removed += removed
  }
  const reset = (record) => { for (const key of Object.keys(record)) delete record[key] }

  globalThis[globalName] = {
    start() {
      recording = true
      startedAt = now()
      stoppedAt = 0
      probeMs = 0
      components.clear()
      commits.length = 0
      notifyGroups.length = 0
      reset(origins)
      reset(mutations)
      reset(attributeMutations)
      reset(hookSetters)
      for (const store of stores.values()) Object.assign(store, { notifies: 0, listeners: 0, maxListeners: 0, ms: 0, maxMs: 0, keys: {} })
      observer = new MutationObserver((records) => {
        if (!recording) return
        const startedRecords = now()
        for (const record of records) {
          const region = regionOf(record.target)
          if (record.type === "childList") bump(region, "childList", record.addedNodes.length, record.removedNodes.length)
          else if (record.type === "attributes") {
            bump(region, "attributes")
            const unchanged = record.target.getAttribute(record.attributeName) === record.oldValue
            const key = `${region} ${String(record.target.tagName || "").toLowerCase()}[${record.attributeName}]${unchanged ? " (same value)" : ""}`
            attributeMutations[key] = (attributeMutations[key] || 0) + 1
          } else bump(region, "characterData")
        }
        probeMs += now() - startedRecords
      })
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true })
    },
    stop() {
      recording = false
      stoppedAt = now()
      observer?.disconnect()
    },
    snapshot() {
      return {
        seconds: ((stoppedAt || now()) - startedAt) / 1000,
        probeMs,
        hookInjected,
        components: [...components.values()].sort((left, right) => right.renders - left.renders),
        commits,
        origins: Object.entries(origins).sort((left, right) => right[1].renders - left[1].renders).slice(0, 40)
          .map(([origin, entry]) => ({ origin, renders: entry.renders, names: Object.entries(entry.names).sort((left, right) => right[1] - left[1]).slice(0, 12) })),
        anonymousSources,
        hookSetters,
        storesRegistered: stores.size,
        stores: [...stores.values()].filter((store) => store.notifies > 0).sort((left, right) => right.listeners - left.listeners),
        notifyGroups,
        mutations,
        attributeMutations: Object.entries(attributeMutations).sort((left, right) => right[1] - left[1]).slice(0, 60),
      }
    },
  }
}

/**
 * `traceHook` ("Component:hookIndex", optional) records the call stacks that
 * dispatch to that hook, to name who keeps setting a state that re-renders.
 */
export const buildRenderProbeSource = ({ traceHook = null, commitLogLimit = 50_000 } = {}) => {
  const [component, index] = String(traceHook ?? "").split(":")
  const hook = traceHook ? { component, index: Number(index) } : null
  return `(${probeFactory.toString()})(${JSON.stringify(RENDER_PROBE_GLOBAL)}, ${JSON.stringify(hook)}, ${commitLogLimit});`
}

const rate = (count, seconds) => (seconds > 0 ? Math.round((count / seconds) * 10) / 10 : null)

/** Reads the probe from the page as raw JSON text (it can be large). */
export const readRenderProbe = async (evaluate) => {
  const raw = await evaluate(`JSON.stringify(globalThis[${JSON.stringify(RENDER_PROBE_GLOBAL)}]?.snapshot() ?? null)`)
  return raw && raw !== "null" ? raw : null
}

/**
 * Condenses a probe snapshot for the run summary. `storeProbe` is false when
 * the build does not report store notifications (any build but the diagnostic
 * one): the store list is then missing, not empty.
 */
export const summarizeRenderProbe = (snapshot) => {
  if (!snapshot) return null
  const { seconds } = snapshot
  const fibersRendered = snapshot.commits.reduce((total, entry) => total + entry.renders, 0)
  const withoutDomChange = snapshot.commits.reduce((total, entry) => total + (entry.rendersWithoutDomChange ?? 0), 0)
  return {
    seconds: Math.round(seconds * 100) / 100,
    probeMs: Math.round(snapshot.probeMs),
    hookInjected: snapshot.hookInjected,
    commits: snapshot.commits.length,
    commitsPerSecond: rate(snapshot.commits.length, seconds),
    rendersPerSecond: rate(fibersRendered, seconds),
    rendersWithoutDomChangePerSecond: rate(withoutDomChange, seconds),
    rendersWithoutDomChangePercent: fibersRendered > 0 ? Math.round((withoutDomChange / fibersRendered) * 1000) / 10 : null,
    components: snapshot.components.slice(0, 40).map((entry) => ({
      name: entry.name,
      renders: entry.renders,
      perSecond: rate(entry.renders, seconds),
      withoutDomChange: entry.rendersWithoutDomChange,
      mounts: entry.mounts,
      cause: Object.fromEntries(Object.entries(entry.cause).filter(([, count]) => count > 0)),
      output: entry.output,
      domWrites: entry.domUpdates + entry.textUpdates + entry.domPlacements,
      regions: entry.regions,
      changedProps: Object.entries(entry.changedProps).sort((left, right) => right[1] - left[1]).slice(0, 5).map(([key, count]) => `${key}:${count}`),
    })),
    origins: snapshot.origins.slice(0, 15),
    storeProbe: snapshot.storesRegistered > 0,
    stores: snapshot.storesRegistered > 0
      ? snapshot.stores.slice(0, 20).map((store) => ({
        id: store.id,
        createdAt: store.frames,
        notifies: store.notifies,
        perSecond: rate(store.notifies, seconds),
        listenersPerSecond: rate(store.listeners, seconds),
        maxListeners: store.maxListeners,
        ms: Math.round(store.ms * 10) / 10,
        changedKeys: Object.entries(store.keys).sort((left, right) => right[1] - left[1]).slice(0, 8).map(([key, count]) => `${key}:${count}`),
      }))
      : null,
    mutationsPerSecond: Object.fromEntries(Object.entries(snapshot.mutations)
      .sort((left, right) => right[1].records - left[1].records)
      .map(([region, entry]) => [region, rate(entry.records, seconds)])),
    topAttributeMutations: snapshot.attributeMutations.slice(0, 15),
    hookSetters: Object.entries(snapshot.hookSetters).sort((left, right) => right[1] - left[1]).slice(0, 10),
  }
}

/** Prints the summary from `summarizeRenderProbe`; `mapFrame` maps store creation sites. */
export const printRenderProbe = (summary, { top = 20, perUnit = null, mapFrame = (frame) => frame } = {}) => {
  if (!summary) return
  console.log(`\nRender probe (attribution only; the probe's own cost was ${summary.probeMs} ms, so timings from this run are inflated):`)
  if (!summary.hookInjected) {
    console.log("  React never registered with the probe's hook, so every count below is missing, not zero.")
    return
  }
  console.log(`  ${summary.commits} commits (${summary.commitsPerSecond}/s), ${summary.rendersPerSecond} component renders/s, ${summary.rendersWithoutDomChangePerSecond}/s (${summary.rendersWithoutDomChangePercent ?? 0}%) changed nothing in the DOM`)
  const unit = perUnit ? ` ${"per " + perUnit.label}`.padStart(10) : ""
  console.log(`  ${"renders/s".padStart(9)}${unit} ${"no DOM".padStart(7)}  cause / component`)
  for (const entry of summary.components.slice(0, top)) {
    const per = perUnit ? String(Math.round((entry.renders / perUnit.count) * 10) / 10).padStart(10) : ""
    const cause = Object.entries(entry.cause).map(([key, count]) => `${key}:${count}`).join(" ")
    console.log(`  ${String(entry.perSecond).padStart(9)}${per} ${String(entry.withoutDomChange).padStart(7)}  ${entry.name}  [${cause}]${entry.changedProps.length ? ` changed ${entry.changedProps.join(" ")}` : ""}`)
  }
  if (summary.stores === null) {
    console.log("  Store notifications: not recorded; they need the diagnostic build (bun run build:web:diag).")
  } else {
    console.log("  Store notifications (notifies/s, listeners run/s, changed keys, created at):")
    for (const store of summary.stores.slice(0, 10)) {
      console.log(`  ${String(store.perSecond).padStart(9)} ${String(store.listenersPerSecond).padStart(9)}  ${store.changedKeys.join(" ")}  @ ${store.createdAt.slice(0, 2).map(mapFrame).join(" <- ")}`)
    }
  }
  console.log(`  DOM mutation records/s by region: ${Object.entries(summary.mutationsPerSecond).map(([region, perSecond]) => `${region} ${perSecond}`).join(", ") || "none"}`)
  if (summary.hookSetters.length) {
    console.log("  Dispatches to the traced hook:")
    for (const [site, count] of summary.hookSetters) console.log(`  ${String(count).padStart(9)}  ${site}`)
  }
}
