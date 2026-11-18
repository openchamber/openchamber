import { rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import process from "node:process"

import { CdpClient, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from "../perf/cdp.mjs"
import { prioritizeWindowsProcess } from "./windows-priority.mjs"

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 }
// A phone the size of an iPhone 15; the app serves its phone layout at /mobile.html.
const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 }
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const KEYS = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  End: { code: "End", keyCode: 35 },
  F10: { code: "F10", keyCode: 121 },
}
export const MOD = process.platform === "darwin" ? "meta" : "ctrl"
const modifierMask = (modifiers) => modifiers.map((name) => (name === "mod" ? MOD : name)).reduce((sum, name) => sum | MODIFIERS[name], 0)

export const DEEP_QUERY = `((selector) => {
  const roots = [document]
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of roots[index].querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot)
  }
  return roots.flatMap((root) => [...root.querySelectorAll(selector)])
})`

const FIND_ELEMENTS = `(selector, text, exact, all, inView) => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = getComputedStyle(element)
    return style.visibility !== "hidden" && style.display !== "none" && element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  const matches = []
  for (const element of ${DEEP_QUERY}(selector)) {
    const content = (element.innerText ?? element.textContent ?? "").trim()
    if (text !== null && (exact ? content !== text : !content.includes(text))) continue
    if (!all && !visible(element)) continue
    if (inView) {
      const holds = (node) => node.getClientRects().length > 0 && (node.innerText ?? "").includes(text)
      const holders = text === null ? [element] : [element, ...element.querySelectorAll("*")].filter((node) => holds(node) && ![...node.children].some(holds))
      const visibleBox = (node) => {
        const rect = node.getBoundingClientRect()
        let box = { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, innerHeight), left: Math.max(rect.left, 0), right: Math.min(rect.right, innerWidth) }
        for (let parent = node.parentElement ?? node.getRootNode().host; parent; parent = parent.parentElement ?? parent.getRootNode().host) {
          if (getComputedStyle(parent).overflow === "visible") continue
          const clip = parent.getBoundingClientRect()
          box = { top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom), left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right) }
        }
        return box.bottom > box.top && box.right > box.left
      }
      const onScreen = holders.some(visibleBox)
      if (!onScreen) continue
    }
    matches.push(element)
  }
  return matches
}`

export class Page {
  constructor(client) {
    this.client = client
    this.consoleErrors = []
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      this.consoleErrors.push(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text)
    })
    this.sourceUpdates = []
    this.expectedLoads = 0
    client.on("Page.loadEventFired", () => {
      if (this.expectedLoads > 0) this.expectedLoads -= 1
      else this.sourceUpdates.push("the page reloaded on its own")
    })
    client.on("Runtime.consoleAPICalled", ({ type, args }) => {
      const first = String(args[0]?.value ?? "")
      if (/^\[vite\] (hot updated|page reload)/.test(first)) this.sourceUpdates.push(first.slice(7, 200))
      if (type !== "error") return
      const parts = args.map((arg) => String(arg.description ?? arg.value ?? "")).filter((part) => part && !/^%[os]/.test(part))
      this.consoleErrors.push(parts.join(" ").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 4).join(" | ").slice(0, 500))
    })
  }

  static async open(chromePort, browserContextId) {
    const version = await fetch(`http://127.0.0.1:${chromePort}/json/version`).then((response) => response.json())
    const root = new CdpClient(version.webSocketDebuggerUrl)
    await root.connect()
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId })
    root.close()
    const client = new CdpClient(`ws://127.0.0.1:${chromePort}/devtools/page/${targetId}`)
    await client.connect()
    const page = new Page(client)
    await client.send("Page.enable")
    await client.send("Runtime.enable")
    await client.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: false })
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] })
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    return page
  }

  async evaluate(expression) {
    const result = await this.client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 30_000 })
    if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result?.value ?? null
  }

  async navigate(url) {
    this.expectedLoads += 1
    const loaded = this.client.once("Page.loadEventFired", 90_000)
    await this.client.send("Page.navigate", { url })
    await loaded
  }

  async reload() {
    this.expectedLoads += 1
    const loaded = this.client.once("Page.loadEventFired", 90_000)
    await this.client.send("Page.reload", { ignoreCache: false })
    await loaded
  }

  async poll(expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let value = null
    do {
      value = await this.evaluate(`(() => { try { return ${expression} } catch (error) { return null } })()`)
      if (value) return value
      await wait(100)
    } while (Date.now() < deadline)
    return value
  }

  query({ selector, text = null, exact = false, all = false, inView = false }) {
    return `(${FIND_ELEMENTS})(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${exact}, ${all}, ${inView})`
  }

  async point(target, timeoutMs) {
    const locate = `(() => {
      const element = ${this.query(target)}[${target.index ?? 0}]
      if (!element) return null
      if (!${Boolean(target.noScroll)}) element.scrollIntoView({ block: "nearest", inline: "nearest" })
      const rect = element.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const hit = element.getRootNode().elementFromPoint?.(x, y) ?? document.elementFromPoint(x, y)
      return { x, y, hits: Boolean(hit && (element === hit || element.contains(hit) || hit.contains(element))) }
    })()`
    const deadline = Date.now() + timeoutMs
    let previous = null
    while (Date.now() < deadline) {
      const current = await this.poll(locate, Math.max(0, deadline - Date.now()))
      if (!current) return null
      if (current.hits && previous && Math.abs(previous.x - current.x) < 1 && Math.abs(previous.y - current.y) < 1) return current
      previous = current
      await wait(120)
    }
    return previous
  }

  async mouse(type, point, extra = {}) {
    await this.client.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra }, { timeoutMs: 30_000 })
  }

  // A point another element still covers when the wait ends comes back
  // unused: pressing there would act on whatever lies on top.
  async hover(target, timeoutMs, modifiers = []) {
    const point = await this.point(target, timeoutMs)
    if (!point?.hits) return point
    await this.mouse("mouseMoved", point, { modifiers: modifierMask(modifiers) })
    return point
  }

  // Touch from here on, at a phone's size: clicks become taps.
  async usePhone() {
    this.phone = true
    await this.client.send("Emulation.setDeviceMetricsOverride", { ...PHONE_VIEWPORT, mobile: true })
    await this.client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  }

  async touch(point, holdMs) {
    await this.client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] })
    await wait(holdMs)
    await this.client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  }

  // `count` 2 is a double-click: two press-release pairs, the second counted
  // as the second click, which is what fires dblclick.
  // `modifiers` (as on `press`) are held during the move and the click.
  async click(target, timeoutMs, { button = "left", count = 1, modifiers = [] } = {}) {
    if (this.phone || button === "long") {
      const point = await this.point(target, timeoutMs)
      if (point?.hits) await this.touch(point, button === "long" ? 800 : 40)
      return point
    }
    const point = await this.hover(target, timeoutMs, modifiers)
    if (!point?.hits) return point
    const buttons = button === "right" ? 2 : 1
    const mask = modifierMask(modifiers)
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.mouse("mousePressed", point, { button, buttons, clickCount, modifiers: mask })
      await this.mouse("mouseReleased", point, { button, buttons: 0, clickCount, modifiers: mask })
    }
    return point
  }

  // A native HTML drag: Chrome hands the drag data to the client instead of
  // running its own drag loop, which a headless browser cannot finish. The
  // source still gets dragstart; dragOver and drop then deliver the data to
  // the page as the browser would.
  async startHtmlDrag(from) {
    await this.client.send("Input.setInterceptDrags", { enabled: true })
    const intercepted = this.client.once("Input.dragIntercepted", 15_000).then(({ data }) => data, () => null)
    try {
      await this.mouse("mouseMoved", from)
      await this.mouse("mousePressed", from, { button: "left", buttons: 1, clickCount: 1 })
      for (let move = 1; move <= 6; move += 1) {
        await this.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + move * 4, y: from.y + move * 3, button: "left", buttons: 1 }, { timeoutMs: 10_000 })
      }
    } catch {
      return null
    }
    return intercepted
  }

  async dragEvent(type, point, data, modifiers = 0) {
    await this.client.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data, modifiers }, { timeoutMs: 10_000 })
  }

  async endHtmlDrag(point) {
    await this.mouse("mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 })
    await this.client.send("Input.setInterceptDrags", { enabled: false })
  }

  // The next file picker the page opens gets `paths` as if the user chose them.
  async armFileChooser(paths) {
    this.fileChooserError = null
    await this.client.send("Page.setInterceptFileChooserDialog", { enabled: true })
    const off = this.client.on("Page.fileChooserOpened", ({ backendNodeId }) => {
      off()
      this.client.send("DOM.setFileInputFiles", { files: paths, backendNodeId })
        .catch((error) => { this.fileChooserError = error.message })
        .finally(() => this.client.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined))
    })
  }

  // Downloads land in `dir`; `downloads` lists them by the name the page gave
  // them, with their state.
  async allowDownloads(dir) {
    this.downloads = new Map()
    this.client.on("Page.downloadWillBegin", ({ guid, suggestedFilename }) => {
      this.downloads.set(guid, { name: suggestedFilename, state: "inProgress" })
    })
    this.client.on("Page.downloadProgress", ({ guid, state }) => {
      const download = this.downloads.get(guid)
      if (download) download.state = state
    })
    await this.client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir })
  }

  // Presses at `from`, moves to `to` in small steps with the button held, and
  // releases there, so pointermove handlers see the path between the two.
  async drag(from, to, moves = 8) {
    await this.mouse("mouseMoved", from)
    await this.mouse("mousePressed", from, { button: "left", buttons: 1, clickCount: 1 })
    for (let move = 1; move <= moves; move += 1) {
      const point = { x: from.x + (to.x - from.x) * move / moves, y: from.y + (to.y - from.y) * move / moves }
      await this.mouse("mouseMoved", point, { button: "left", buttons: 1 })
      await wait(30)
    }
    await this.mouse("mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 })
  }

  async moveMouseAway() {
    await this.mouse("mouseMoved", { x: 2, y: 2 })
  }

  // Canvas output has no DOM text. Read it through the user's selection and Copy.
  async copyVisibleTerminal(target, timeoutMs) {
    const point = await this.hover(target, timeoutMs)
    if (!point?.hits) return false
    const rect = await this.evaluate(`(() => {
      const element = ${this.query(target)}[${target.index}]
      if (!element) return null
      const { left, top, right, bottom } = element.getBoundingClientRect()
      return { left, top, right, bottom }
    })()`)
    if (!rect) return false
    await this.drag(
      { x: rect.left + 2, y: rect.top + 2 },
      { x: rect.right - 2, y: rect.bottom - 2 },
    )
    await this.press("c", ["mod"])
    return true
  }

  async press(key, modifiers = []) {
    const mask = modifierMask(modifiers)
    const known = KEYS[key]
    const isChar = !known && key.length === 1
    const code = known?.code ?? (isChar ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`) : key)
    const keyCode = known?.keyCode ?? (isChar ? key.toUpperCase().charCodeAt(0) : 0)
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mask }
    const text = isChar && !(mask & (MODIFIERS.meta | MODIFIERS.ctrl)) ? key : key === "Enter" && !(mask & ~MODIFIERS.shift) ? "\r" : undefined
    const down = { type: text ? "keyDown" : "rawKeyDown", ...base }
    if (text) down.text = text
    await this.client.send("Input.dispatchKeyEvent", down)
    await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }

  async insertText(text) {
    await this.client.send("Input.insertText", { text })
  }

  async screenshot(file) {
    const { data } = await this.client.send("Page.captureScreenshot", { format: "png" }, { timeoutMs: 30_000 })
    writeFileSync(file, Buffer.from(data, "base64"))
  }

  close() {
    this.client.close()
  }
}

const connectBrowser = async (port) => {
  const deadline = Date.now() + 20_000
  let version = null
  while (!version && Date.now() < deadline) {
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json(), () => null)
    if (!version) await wait(100)
  }
  if (!version) throw new Error("Chrome did not open its debugging port")
  const root = new CdpClient(version.webSocketDebuggerUrl)
  await root.connect()
  return root
}

export const startBrowser = async ({ chrome, headed = false, onSpawn }) => {
  const executable = resolveChrome(chrome)
  const port = await reservePort()
  const profile = resolveProfileDir(null, "verify")
  // A Windows SSH session may have no input devices. Desktop scenarios still
  // use a mouse, including controls behind CSS (hover: hover).
  const pointerArgs = process.platform === "win32"
    ? ["--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"]
    : []
  const child = launchChrome({ chrome: executable, profileDir: profile.dir, port, headless: !headed, extraArgs: ["--lang=en-US", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, ...pointerArgs] })
  profile.removeAfter(child)
  const spawnFailed = new Promise((_, reject) => child.once("error", (error) => reject(new Error(`Chrome did not start: ${error.message}`))))
  const connecting = Promise.resolve().then(() => {
    onSpawn?.(child, profile.dir)
    if (child.pid) prioritizeWindowsProcess(child.pid)
    return connectBrowser(port)
  })
  const root = await Promise.race([connecting, spawnFailed]).catch((error) => {
    child.kill("SIGKILL")
    rmSync(profile.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    throw error
  })
  spawnFailed.catch(() => undefined)
  const newPage = async () => {
    const { browserContextId } = await root.send("Target.createBrowserContext", { disposeOnDetach: false })
    const page = await Page.open(port, browserContextId)
    page.browserContextId = browserContextId
    page.dispose = async () => {
      page.close()
      await root.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined)
    }
    return page
  }
  const stop = async () => {
    if (process.platform === "win32" && child.exitCode === null && child.signalCode === null) {
      // SIGTERM terminates only Windows Chrome's main process. Its helpers
      // retain profile locks, so first let Chrome shut down its own children.
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
      await root.send("Browser.close", {}, { timeoutMs: 3000 }).catch(() => undefined)
      await Promise.race([exited, wait(3000)])
      if (child.exitCode === null && child.signalCode === null) {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        } catch (error) {
          try { process.kill(child.pid, 0) } catch (probe) { if (probe.code === "ESRCH") { root.close(); return } }
          throw error
        }
        await exited
      }
      root.close()
      return
    }
    root.close()
    if (child.exitCode !== null) return
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
    child.kill("SIGTERM")
    await Promise.race([exited, wait(3000)])
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  return { newPage, stop }
}
