/**
 * Page-side startup recorder, installed before any application code runs.
 *
 * "Mounted" and "usable" are different moments, and neither is "the root has
 * children": the HTML splash (`#initial-loading`) is a child of `#root` from
 * the first parsed byte. This records, in milliseconds since the document's
 * navigation started (`performance.timeOrigin`):
 *
 * - `reactMounted`: a child of `#root` carries React's fiber expando, so React
 *   committed its first tree;
 * - `splashGone`: the HTML splash `#initial-loading` is no longer in the
 *   document (it was seen first, or never existed and the document parsed);
 * - `overlayGone`: the React `AppStartupOverlay` (the full-screen splash-colour
 *   layer) left the DOM after it was seen, which is after its fade-out;
 * - `composerPresent`, `composerHittable` (the composer host wins
 *   `elementFromPoint` at its centre), `composerEditable` (its editor is
 *   contenteditable, or a textarea, outside any inert or disabled subtree);
 * - `usable`: all of the above at once, checked in one animation frame;
 * - `sessionRows`: the sidebar shows at least one session row;
 * - the app's own `markStartupTrace` marks, enabled through the
 *   `OPENCHAMBER_STARTUP_TRACE` storage flag, with `modelPickerReady` derived
 *   from `ModelControls:ready` reporting providers and a selected model;
 * - `modelPickerShown` (when a model label is given): the composer footer
 *   shows that model's name. `ModelControls:ready` fires once, and a shell
 *   that renders before providers load can fire it with none, so this DOM
 *   mark is the one to compare across builds.
 *
 * Checks run once per animation frame, where the browser computes layout
 * anyway; a MutationObserver would force layout on every DOM batch and change
 * the startup being measured.
 */

export const STARTUP_PROBE_GLOBAL = "__openchamberStartupProbe"

// The AppStartupOverlay has no test id; its classes are the only handle. The
// probe reports whether it ever saw the overlay, so a renamed class shows up
// as `overlaySeen: false` rather than as an instant `overlayGone`.
const OVERLAY_SELECTOR = 'div.fixed.inset-0[class*="splash-background"]'

export const buildStartupProbeSource = ({ modelLabel = null } = {}) => `(() => {
  if (window.${STARTUP_PROBE_GLOBAL}) return
  try { localStorage.setItem("OPENCHAMBER_STARTUP_TRACE", "1") } catch {}
  const marks = {}
  const seen = { splash: false, overlay: false }
  const set = (name, at) => { if (marks[name] === undefined) marks[name] = Math.round(at) }
  const reactOwned = (element) => Object.keys(element).some((key) => key.startsWith("__reactFiber$"))
  const composerState = () => {
    const host = document.querySelector('[data-chat-input="true"]')
    if (!host) return { present: false, hittable: false, editable: false }
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { present: true, hittable: false, editable: false }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const editor = host.querySelector('[contenteditable="true"], textarea') ?? (host.isContentEditable ? host : null)
    // A contenteditable element is focusable while its tabIndex reads -1, so
    // tabIndex says nothing here; inert or disabled ancestors do.
    const editable = !!editor && (editor.isContentEditable || editor.tagName === "TEXTAREA")
      && !editor.closest('[inert], [aria-disabled="true"]') && !editor.matches(":disabled")
    return { present: true, hittable: !!hit && host.contains(hit), editable }
  }
  let frames = 0
  const check = () => {
    const now = performance.now()
    frames += 1
    const root = document.getElementById("root")
    if (root && marks.reactMounted === undefined) {
      for (const child of root.children) if (child.id !== "initial-loading" && reactOwned(child)) { set("reactMounted", now); break }
    }
    if (document.getElementById("initial-loading")) seen.splash = true
    else if (seen.splash || document.readyState !== "loading") set("splashGone", now)
    if (document.querySelector(${JSON.stringify(OVERLAY_SELECTOR)})) seen.overlay = true
    else if (seen.overlay) set("overlayGone", now)
    const composer = composerState()
    if (composer.present) set("composerPresent", now)
    if (composer.hittable) set("composerHittable", now)
    if (composer.editable) set("composerEditable", now)
    const overlayClear = seen.overlay ? marks.overlayGone !== undefined : marks.reactMounted !== undefined
    if (marks.reactMounted !== undefined && marks.splashGone !== undefined && overlayClear && composer.hittable && composer.editable) set("usable", now)
    if (document.querySelector("[data-session-row]")) set("sessionRows", now)
    const modelLabel = ${JSON.stringify(modelLabel)}
    if (modelLabel && document.querySelector("[data-chat-input-footer]")?.textContent?.includes(modelLabel)) set("modelPickerShown", now)
    if (marks.usable === undefined || marks.sessionRows === undefined || (modelLabel && marks.modelPickerShown === undefined)) {
      if (now < 120000) requestAnimationFrame(check)
    }
  }
  requestAnimationFrame(check)
  const readTrace = () => {
    const start = window.__OPENCHAMBER_STARTUP_TRACE_START__
    const trace = window.__OPENCHAMBER_STARTUP_TRACE__ ?? []
    if (typeof start !== "number") return []
    return trace.map((event) => ({ name: event.name, at: Math.round(start + event.t), data: event.data ?? null }))
  }
  window.${STARTUP_PROBE_GLOBAL} = {
    read() {
      const trace = readTrace()
      const navigation = performance.getEntriesByType("navigation")[0]
      const paint = (name) => performance.getEntriesByType("paint").find((entry) => entry.name === name)?.startTime ?? null
      const ready = trace.find((event) => event.name === "ModelControls:ready")
      const modelPickerReady = trace.find((event) => event.name === "ModelControls:ready"
        && Number(event.data?.providers ?? 0) > 0 && !!event.data?.currentModelId)
      return {
        origin: performance.timeOrigin,
        url: location.href,
        frames,
        seen,
        marks: {
          responseEnd: navigation ? Math.round(navigation.responseEnd) : null,
          domContentLoaded: navigation && navigation.domContentLoadedEventEnd > 0 ? Math.round(navigation.domContentLoadedEventEnd) : null,
          loadEvent: navigation && navigation.loadEventEnd > 0 ? Math.round(navigation.loadEventEnd) : null,
          firstPaint: paint("first-paint") === null ? null : Math.round(paint("first-paint")),
          firstContentfulPaint: paint("first-contentful-paint") === null ? null : Math.round(paint("first-contentful-paint")),
          ...marks,
          modelControlsReady: ready ? ready.at : null,
          modelPickerReady: modelPickerReady ? modelPickerReady.at : null,
        },
        trace,
      }
    },
  }
})()`
