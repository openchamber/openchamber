import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { wait } from "../perf/cdp.mjs"
import { DEEP_QUERY } from "./browser.mjs"
import { PROFILE_KEYS } from "./stand.mjs"

const DEFAULT_TIMEOUT_MS = 20_000
const READY_TIMEOUT_MS = 120_000
const READY = `!document.getElementById("initial-loading") && !!document.querySelector('[data-chat-input] .cm-content[contenteditable="true"]')`
const PHONE_READY = `!document.getElementById("initial-loading") && !!document.querySelector('button[aria-label="Open sessions and projects"]')`
const EDITOR_TEXT = `((element) => {
  if (!element) return null
  return [...element.querySelectorAll(".cm-line")].map((line) => {
    let text = ""
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest(".cm-placeholder")) text += walker.currentNode.nodeValue
    return text
  }).join("\\n")
})`

export class StepFailure extends Error {}

const fail = (message) => { throw new StepFailure(message) }

const fillOnce = (template, step, vars) => template.replace(/\{(\w+)\}/g, (_, key) => {
  const raw = step[key]
  if (raw === undefined && vars[key] === undefined) fail(`target needs "${key}" but the step has none`)
  return String(raw === undefined ? vars[key] : vars[raw] ?? raw)
})

const fill = (template, step, vars) => {
  const once = fillOnce(template, step, vars)
  return once === template ? once : fillOnce(once, step, vars)
}

const resolveTarget = (step, ctx) => {
  const entry = ctx.vocabulary[step.on]
  if (!entry) fail(`"${step.on}" is not in the vocabulary`)
  return {
    selector: fill(entry.selector, step, ctx.vars),
    text: step.text ?? entry.text ?? null,
    exact: Boolean(step.exact),
    index: step.index ?? 0,
    inView: Boolean(step.inView),
    noScroll: Boolean(step.inView),
  }
}

const describe = (step) => `${step.on}${step.text ? ` "${step.text}"` : ""}`

const sessionId = (step, ctx) => {
  const id = ctx.vars[step.session] ?? step.session
  if (!id) fail("the step names no session")
  return id
}

const timeoutOf = (step) => step.timeout ? step.timeout * 1000 : DEFAULT_TIMEOUT_MS

const projectPath = (ctx, file) => join(ctx.stand.project, file)

const waitForReady = async (ctx) => {
  const ready = await ctx.page.poll(ctx.page.phone ? PHONE_READY : READY, READY_TIMEOUT_MS)
  if (!ready) fail("the app did not show its composer")
  await ctx.page.moveMouseAway()
}

const sessionStatus = async (ctx, id) => {
  try {
    return ctx.stand.cli(["status", "--session", id]).sessionStatus?.type ?? "idle"
  } catch (error) {
    return `unknown (${error.message.slice(0, 120)})`
  }
}

const visibleState = async (ctx, target) => ctx.page.evaluate(`(() => {
  const all = ${DEEP_QUERY}(${JSON.stringify(target.selector)}).length
  const shown = ${ctx.page.query(target)}
  return { all, shown: shown.length, texts: shown.slice(0, 4).map((element) => (element.innerText ?? "").trim().replace(/\\s+/g, " ").slice(0, 80)), disabled: shown.map((element) => element.disabled === true || element.getAttribute("aria-disabled") === "true") }
})()`)

const SEE_CHECK = (step) => (state) => {
  if (step.count !== undefined && state.shown !== step.count) return false
  if (step.count === undefined && state.shown === 0) return false
  if (step.disabled !== undefined && !state.disabled.slice(0, Math.max(1, state.shown)).every((value) => value === step.disabled)) return false
  return true
}

const waitForState = async (ctx, target, check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let state = await visibleState(ctx, target)
  while (!check(state) && Date.now() < deadline) {
    await wait(150)
    state = await visibleState(ctx, target)
  }
  return { ok: check(state), state }
}

const stateLine = (state) => `${state.shown} visible of ${state.all} matching${state.texts.length ? `: ${state.texts.map((text) => JSON.stringify(text)).join(", ")}` : ""}`

const expectText = (actual, step, what) => {
  if (step.equals !== undefined && actual !== step.equals) return `${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(step.equals)}`
  if (step.contains !== undefined && !actual.includes(step.contains)) return `${what} ${JSON.stringify(actual.slice(0, 200))} does not contain ${JSON.stringify(step.contains)}`
  return null
}

// Files a step hands to the page (a drop from the desktop, a file picker),
// written next to the scenario's artifacts, outside the project.
const scratchFiles = (files, ctx) => files.map(({ name, content }) => {
  const file = join(ctx.dir, "scratch", name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Array.isArray(content) ? content.join("\n") : content)
  return file
})

const ACTIONS = {
  async "session.create"(step, ctx) {
    const created = ctx.stand.cli(["create", "--title", step.title ?? `verify ${step.as}`])
    ctx.vars[step.as] = created.sessionId
  },
  async "session.send"(step, ctx) {
    const args = ["send", "--session", sessionId(step, ctx), "--prompt", step.prompt, "--model", step.model ?? ctx.defaultModel, "--wait", "--timeout", String(step.timeout ?? 90)]
    if (step.goal) args.push("--goal")
    if (step.wait === false) ctx.background.push(ctx.stand.cliInBackground(args))
    else ctx.stand.cli(args, ((step.timeout ?? 90) + 30) * 1000)
  },
  async "session.idle"(step, ctx) {
    const id = sessionId(step, ctx)
    const deadline = Date.now() + timeoutOf(step)
    while (Date.now() < deadline) {
      if (await sessionStatus(ctx, id) === "idle") return
      await wait(250)
    }
    fail(`session ${step.session} is still ${await sessionStatus(ctx, id)}`)
  },
  async "session.busy"(step, ctx) {
    const id = sessionId(step, ctx)
    const deadline = Date.now() + timeoutOf(step)
    while (Date.now() < deadline) {
      if (await sessionStatus(ctx, id) === "busy") return
      await wait(150)
    }
    fail(`session ${step.session} never became busy`)
  },
  async "file.write"(step, ctx) {
    const content = Array.isArray(step.content) ? step.content.join("\n") : step.content
    for (let n = 1; n <= (step.times ?? 1); n += 1) {
      const file = projectPath(ctx, step.path.replaceAll("{n}", String(n).padStart(2, "0")))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  },
  async "file.delete"(step, ctx) {
    rmSync(projectPath(ctx, step.path), { force: true })
  },
  async "file.expect"(step, ctx) {
    const file = projectPath(ctx, step.path)
    const deadline = Date.now() + timeoutOf(step)
    let problem = null
    do {
      if (step.exists !== undefined) {
        problem = existsSync(file) === step.exists ? null : `${step.path} ${step.exists ? "does not exist" : "still exists"}`
        if (!problem) return
        await wait(200)
        continue
      }
      const actual = existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null
      problem = actual === null ? `${step.path} does not exist${ctx.page.fileChooserError ? `; the file picker failed: ${ctx.page.fileChooserError}` : ""}` : expectText(actual, step, step.path)
      if (!problem) return
      await wait(200)
    } while (Date.now() < deadline)
    fail(problem)
  },
  async settings(step, ctx) {
    const values = step.values ?? {}
    const unknown = Object.keys(values).filter((key) => !PROFILE_KEYS.includes(key))
    if (unknown.length) fail(`settings ${unknown.join(", ")} are not profile settings, so the reset could not undo them`)
    const response = await fetch(`${ctx.stand.apiUrl}/api/config/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    })
    if (!response.ok) fail(`saving settings answered ${response.status}`)
  },
  async "server.stop"(step, ctx) {
    await ctx.stand.stopApi()
  },
  async "server.start"(step, ctx) {
    await ctx.stand.startApi()
  },
  async open(step, ctx) {
    const query = step.session ? `?session=${encodeURIComponent(sessionId(step, ctx))}` : ""
    if (step.phone) await ctx.page.usePhone()
    await ctx.page.navigate(`${ctx.stand.uiUrl}/${ctx.page.phone ? "mobile.html" : ""}${query}`)
    await waitForReady(ctx)
    if (step.session && !ctx.page.phone) {
      const shown = await ctx.page.poll(`!!document.querySelector('[data-session-row="${sessionId(step, ctx)}"][aria-current="page"]')`, READY_TIMEOUT_MS)
      if (!shown) fail(`session ${step.session} did not open`)
    }
  },
  async reload(step, ctx) {
    await ctx.page.reload()
    if (step.ready !== false) await waitForReady(ctx)
  },
  async click(step, ctx) {
    const point = await ctx.page.click(resolveTarget(step, ctx), timeoutOf(step), { button: ["right", "long"].includes(step.button) ? step.button : "left", count: step.clicks ?? 1, modifiers: step.mods ?? [] })
    if (!point) fail(`nothing to click: ${describe(step)} is not visible`)
    if (!point.hits) fail(`nothing to click: ${describe(step)} stays covered by another element`)
  },
  async dragStart(step, ctx) {
    if (step.files) {
      ctx.drag = { data: { items: [], files: scratchFiles(step.files, ctx), dragOperationsMask: 1 }, native: false }
      return
    }
    const from = await ctx.page.point(resolveTarget(step, ctx), timeoutOf(step))
    if (!from) fail(`nothing to drag: ${describe(step)} is not visible`)
    const data = await ctx.page.startHtmlDrag(from)
    if (!data) {
      await ctx.page.endHtmlDrag(from)
      fail(`${describe(step)} did not start a drag`)
    }
    ctx.drag = { data, native: true }
  },
  async dragOver(step, ctx) {
    if (!ctx.drag) fail("dragOver needs a dragStart first")
    const point = await ctx.page.point({ ...resolveTarget(step, ctx), noScroll: true }, timeoutOf(step))
    if (!point?.hits) fail(`nothing to drag over: ${describe(step)} is not on screen`)
    await ctx.page.dragEvent("dragEnter", point, ctx.drag.data)
    await ctx.page.dragEvent("dragOver", point, ctx.drag.data)
  },
  async drop(step, ctx) {
    if (!ctx.drag) fail("drop needs a dragStart first")
    const point = await ctx.page.point({ ...resolveTarget(step, ctx), noScroll: true }, timeoutOf(step))
    if (!point?.hits) fail(`nothing to drop on: ${describe(step)} is not on screen`)
    const { data, native } = ctx.drag
    ctx.drag = null
    await ctx.page.dragEvent("dragEnter", point, data)
    await ctx.page.dragEvent("dragOver", point, data)
    await ctx.page.dragEvent("drop", point, data)
    if (native) await ctx.page.endHtmlDrag(point)
  },
  async dragCancel(step, ctx) {
    if (!ctx.drag?.native) fail("dragCancel needs a dragStart from a row first")
    const point = await ctx.page.point({ ...resolveTarget(step, ctx), noScroll: true }, timeoutOf(step))
    if (!point) fail(`nothing to end the drag on: ${describe(step)} is not on screen`)
    const { data } = ctx.drag
    ctx.drag = null
    await ctx.page.dragEvent("dragCancel", point, data)
    await ctx.page.endHtmlDrag(point)
  },
  async chooseFiles(step, ctx) {
    await ctx.page.armFileChooser(scratchFiles(step.files, ctx))
  },
  async download(step, ctx) {
    const deadline = Date.now() + timeoutOf(step)
    let found = null
    do {
      found = [...ctx.page.downloads.values()].find((download) => download.name === step.name) ?? null
      if (found?.state === "completed") break
      await wait(150)
    } while (Date.now() < deadline)
    if (found?.state !== "completed") fail(found ? `the download of ${step.name} is ${found.state}` : `no download named ${step.name}; got ${[...ctx.page.downloads.values()].map((download) => download.name).join(", ") || "none"}`)
    if (step.contains !== undefined) {
      const problem = expectText(readFileSync(join(ctx.downloadDir, step.name), "utf8"), step, `the downloaded ${step.name}`)
      if (problem) fail(problem)
    }
  },
  async hover(step, ctx) {
    const point = await ctx.page.hover(resolveTarget(step, ctx), timeoutOf(step), step.mods ?? [])
    if (!point) fail(`nothing to hover: ${describe(step)} is not visible`)
    if (!point.hits) fail(`nothing to hover: ${describe(step)} stays covered by another element`)
  },
  async drag(step, ctx) {
    if (!step.to?.on) fail("a drag needs \"to\" with its own \"on\"")
    const from = await ctx.page.point(resolveTarget(step, ctx), timeoutOf(step))
    if (!from) fail(`nothing to drag from: ${describe(step)} is not visible`)
    // Scrolling to the destination would move the origin already measured, so
    // both ends have to be on screen together.
    const to = await ctx.page.point({ ...resolveTarget(step.to, ctx), noScroll: true }, timeoutOf(step))
    if (!to?.hits) fail(`nothing to drag to: ${describe(step.to)} is not on screen with ${describe(step)}`)
    await ctx.page.drag(from, to)
  },
  async wheel(step, ctx) {
    const point = await ctx.page.point({ ...resolveTarget(step, ctx), noScroll: true }, timeoutOf(step))
    if (!point) fail(`nothing to scroll: ${describe(step)} is not visible`)
    for (let turn = 0; turn < (step.times ?? 1); turn += 1) {
      await ctx.page.mouse("mouseWheel", point, { deltaX: step.dx ?? 0, deltaY: step.dy ?? 0 })
      await wait(120)
    }
  },
  async type(step, ctx) {
    await ctx.page.insertText(step.text)
  },
  async press(step, ctx) {
    for (let count = 0; count < (step.times ?? 1); count += 1) await ctx.page.press(step.key, step.mods ?? [])
  },
  async see(step, ctx) {
    const target = resolveTarget(step, ctx)
    const { ok, state } = await waitForState(ctx, target, SEE_CHECK(step), timeoutOf(step))
    if (!ok) fail(`expected ${describe(step)}${step.count !== undefined ? ` ×${step.count}` : ""}${step.disabled !== undefined ? (step.disabled ? " disabled" : " enabled") : ""}; found ${stateLine(state)}`)
  },
  async gone(step, ctx) {
    const target = resolveTarget(step, ctx)
    const { ok, state } = await waitForState(ctx, target, (current) => current.shown === 0, timeoutOf(step))
    if (!ok) fail(`expected ${describe(step)} to disappear; still ${stateLine(state)}`)
  },
  async steady(step, ctx) {
    const target = resolveTarget(step, ctx)
    const deadline = Date.now() + (step.ms ?? 1500)
    while (Date.now() < deadline) {
      const state = await visibleState(ctx, target)
      if (state.shown !== step.count) fail(`expected ${describe(step)} to stay at ${step.count}; became ${stateLine(state)}`)
      await wait(150)
    }
  },
  async editor(step, ctx) {
    const selector = "[data-chat-input] .cm-content"
    const deadline = Date.now() + timeoutOf(step)
    let problem = null
    do {
      const actual = await ctx.page.evaluate(`${EDITOR_TEXT}(document.querySelector(${JSON.stringify(selector)}))`)
      problem = actual === null ? `no editor at ${selector}` : step.empty ? (actual === "" ? null : `the editor holds ${JSON.stringify(actual)}`) : expectText(actual, step, "the editor")
      if (!problem) return
      await wait(150)
    } while (Date.now() < deadline)
    fail(problem)
  },
  async url(step, ctx) {
    const deadline = Date.now() + timeoutOf(step)
    let actual = ""
    do {
      actual = await ctx.page.evaluate("location.href")
      if (actual.includes(fill(step.contains, step, ctx.vars))) return
      await wait(150)
    } while (Date.now() < deadline)
    fail(`the URL is ${actual}, expected it to contain ${step.contains}`)
  },
  async remember(step, ctx) {
    const target = resolveTarget(step, ctx)
    const value = await ctx.page.evaluate(`(${ctx.page.query(target)}[${target.index}] ?? null)?.getAttribute(${JSON.stringify(step.attr)}) ?? null`)
    if (value === null) fail(`${describe(step)} has no ${step.attr}`)
    ctx.vars[step.as] = value
  },
  async clipboard(step, ctx) {
    if (step.set !== undefined) {
      await ctx.page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(step.set)})`)
      return
    }
    // `{var}` placeholders name remembered values, as in `url`.
    const expected = {
      equals: step.equals === undefined ? undefined : fill(step.equals, step, ctx.vars),
      contains: step.contains === undefined ? undefined : fill(step.contains, step, ctx.vars),
    }
    const deadline = Date.now() + timeoutOf(step)
    let actual = ""
    do {
      actual = await ctx.page.evaluate("navigator.clipboard.readText().catch((error) => 'clipboard error: ' + error.message)")
      if (!expectText(actual, expected, "the clipboard")) return
      await wait(150)
    } while (Date.now() < deadline)
    fail(expectText(actual, expected, "the clipboard"))
  },
  async screenshot(step, ctx) {
    await ctx.page.screenshot(join(ctx.dir, `${String(++ctx.shots).padStart(2, "0")}-${step.name}.png`))
    ctx.artifacts.push(`${String(ctx.shots).padStart(2, "0")}-${step.name}.png`)
  },
  async inspect(step, ctx) {
    const found = await ctx.page.evaluate(`${DEEP_QUERY}(${JSON.stringify(step.selector)}).slice(0, ${step.limit ?? 30}).map((element) => ({
      tag: element.tagName.toLowerCase(),
      attributes: Object.fromEntries([...element.attributes].filter((attribute) => attribute.name !== "class" && attribute.name !== "style").map((attribute) => [attribute.name, attribute.value.slice(0, 120)])),
      visible: element.checkVisibility(),
      shadow: Boolean(element.shadowRoot),
      text: (element.innerText ?? "").trim().replace(/\\s+/g, " ").slice(0, ${step.full ? 100000 : 160}),
      props: Object.fromEntries(${JSON.stringify(step.props ?? [])}.map((name) => [name, element[name]])),
    }))`)
    const name = `inspect-${++ctx.shots}.json`
    writeFileSync(join(ctx.dir, name), JSON.stringify({ selector: step.selector, found }, null, 2))
    ctx.artifacts.push(name)
  },
  async pause(step) {
    await wait(step.ms)
  },
}

export const ACTION_NAMES = Object.keys(ACTIONS)

export const runStep = async (step, ctx) => {
  const action = ACTIONS[step.do]
  if (!action) fail(`unknown step "${step.do}"`)
  await action(step, ctx)
}
