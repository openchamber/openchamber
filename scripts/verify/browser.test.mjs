import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import process from "node:process"
import test from "node:test"

import { CdpClient, resolveChrome } from "../perf/cdp.mjs"
import { startBrowser } from "./browser.mjs"
import { runStep } from "./steps.mjs"

test("editor caret assertions distinguish the focused cursor from matching text", async (t) => {
  try { resolveChrome() } catch { t.skip("Chrome is not installed"); return }
  const browser = await startBrowser({})
  try {
    const page = await browser.newPage()
    try {
      await page.evaluate(`document.body.innerHTML = '<div data-chat-input><div class="cm-content" contenteditable="true"><div class="cm-line">Recalled then dropped</div></div></div><button>Elsewhere</button>'`)
      const caretAt = async (offset) => page.evaluate(`(() => {
        const editor = document.querySelector(".cm-content")
        editor.focus()
        getSelection().collapse(editor.firstChild.firstChild, ${offset})
      })()`)
      const ctx = { page }
      const step = { do: "editor", equals: "Recalled then dropped", timeout: 0.001 }
      await caretAt(0)
      await runStep({ ...step, caret: "start" }, ctx)
      await assert.rejects(runStep({ ...step, caret: "end" }, ctx), /caret/)
      await caretAt(step.equals.length)
      await runStep({ ...step, caret: "end" }, ctx)
      await assert.rejects(runStep({ ...step, caret: "start" }, ctx), /caret/)
      await page.evaluate("getSelection().setBaseAndExtent(document.querySelector('.cm-line').firstChild, 0, document.querySelector('.cm-line').firstChild, 20)")
      await assert.rejects(runStep({ ...step, caret: "start" }, ctx), /caret/)
      await page.evaluate("document.querySelector('button').focus()")
      await assert.rejects(runStep({ ...step, caret: "end" }, ctx), /caret/)
      await assert.rejects(runStep({ ...step, caret: "middle" }, ctx), /caret needs start or end/)
    } finally {
      await page.dispose()
    }
  } finally {
    await browser.stop()
  }
})

test("Windows browser shutdown releases every owned temporary profile", { skip: process.platform !== "win32" }, async (t) => {
  try { resolveChrome() } catch { t.skip("Chrome is not installed"); return }
  const mkdtemp = fs.mkdtempSync
  const profiles = []
  const send = CdpClient.prototype.send
  let closeCommands = 0
  t.mock.method(CdpClient.prototype, "send", function (method, params, options) {
    if (method === "Browser.close") {
      assert.equal(options?.timeoutMs, 3000)
      closeCommands += 1
    }
    return send.call(this, method, params, options)
  })
  t.mock.method(fs, "mkdtempSync", (...args) => {
    const dir = mkdtemp(...args)
    if (String(args[0]).includes("openchamber-perf-verify")) profiles.push(dir)
    return dir
  })
  syncBuiltinESMExports()
  try {
    for (let round = 0; round < 3; round += 1) {
      const browser = await startBrowser({})
      try {
        const page = await browser.newPage()
        await page.evaluate("document.body.textContent = 'Chrome teardown check'")
        await page.dispose()
      } finally {
        await browser.stop()
      }
      assert.equal(fs.existsSync(profiles[round]), false)
    }
    assert.equal(profiles.length, 3)
    assert.equal(closeCommands, 3)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("Windows priority failures remove the owned Chrome profile", { skip: process.platform !== "win32" }, async (t) => {
  try { resolveChrome() } catch { t.skip("Chrome is not installed"); return }
  const mkdtemp = fs.mkdtempSync
  let profile
  t.mock.method(fs, "mkdtempSync", (...args) => {
    const dir = mkdtemp(...args)
    if (String(args[0]).includes("openchamber-perf-verify")) profile = dir
    return dir
  })
  t.mock.method(os, "setPriority", () => { throw Object.assign(new Error("Process already exited"), { code: "ESRCH" }) })
  syncBuiltinESMExports()
  try {
    await assert.rejects(startBrowser({}), { code: "ESRCH" })
    assert.ok(profile)
    assert.equal(fs.existsSync(profile), false)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("hover waits until the page stops replacing the target in place", async (t) => {
  try { resolveChrome() } catch { t.skip("Chrome is not installed"); return }
  const browser = await startBrowser({})
  try {
    const page = await browser.newPage()
    try {
      // Like a diff settling after it opens: the row is rebuilt at the same
      // place for a while, and hover state lives on the node the pointer entered.
      await page.evaluate(`(() => {
        const row = () => {
          const element = document.createElement("div")
          element.className = "row"
          element.style.cssText = "width:200px;height:40px"
          element.addEventListener("pointermove", () => { element.dataset.hovered = "" })
          return element
        }
        document.body.replaceChildren(row())
        let rebuilds = 0
        const timer = setInterval(() => {
          document.body.replaceChildren(row())
          globalThis.__rebuilds = ++rebuilds
          if (rebuilds === 12) clearInterval(timer)
        }, 60)
      })()`)
      await page.hover({ selector: ".row" }, 5000)
      assert.equal(await page.evaluate("globalThis.__rebuilds"), 12)
      assert.equal(await page.evaluate("document.querySelector('.row').hasAttribute('data-hovered')"), true)
    } finally {
      await page.dispose()
    }
  } finally {
    await browser.stop()
  }
})

test("desktop hover controls work without host input devices, and phone emulation stays touch-only", async (t) => {
  try { resolveChrome() } catch { t.skip("Chrome is not installed"); return }
  const browser = await startBrowser({})
  try {
    const page = await browser.newPage()
    try {
      assert.equal(await page.evaluate("matchMedia('(hover: hover)').matches && matchMedia('(pointer: fine)').matches"), true)
      await page.evaluate(`document.body.innerHTML = '<style>.tab{width:200px;height:100px}.close{opacity:0}@media(hover:hover){.tab:hover .close{opacity:1}}</style><div class="tab"><button class="close">Close</button></div>'`)
      await page.hover({ selector: ".tab" }, 5000)
      assert.equal(await page.poll("getComputedStyle(document.querySelector('.close')).opacity === '1'", 5000), true)
      await page.usePhone()
      assert.equal(await page.evaluate("matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches"), true)
    } finally {
      await page.dispose()
    }
  } finally {
    await browser.stop()
  }
})
