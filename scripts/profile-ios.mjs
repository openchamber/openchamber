#!/usr/bin/env node
/**
 * Measures the Capacitor app on a real iPhone through its WebKit inspector.
 *
 * The simulator runs WebKit on the Mac's CPU and composites differently, so
 * keyboard latency, frame rate and compositor behaviour are only true on a
 * device. The pymobiledevice3 bridge exposes the app's WKWebView over CDP;
 * this script drives it. Setup and what each figure means:
 * `performance-engineering` skill, references/ios-webkit.md.
 *
 * Commands:
 *   targets                     Lists the pages the bridge sees.
 *   eval <expression>           Prints the JSON value of an expression.
 *   keyboard [--runs N] [--setup js] [--teardown js] [--target selector]
 *                               Taps the composer and reports, per run, the time
 *                               to focus, to the keyboard's start
 *                               (`oc:keyboard-anim`), and main-thread blocks
 *                               over 12 ms in the 500 ms after focus.
 *   frames [--setup js] [--target selector] [--ms N]
 *                               Records, every frame from the tap through the
 *                               keyboard open, where the composer, its riders, the last turn
 *                               and the transcript's scroll stand; prints the
 *                               frames where something moved.
 *   dom-weight [--min N]        Subtrees of at least N elements (default 800):
 *                               where a large always-mounted tree hides.
 *   screenshot [--out path]     Saves the page as PNG (default ios-screen.png).
 *
 * Validity: a run fails when the tap target is missing, focus never arrives,
 * or the keyboard never starts. The last one is what a hardware keyboard
 * attached to a simulator, or a field that cannot take focus, looks like.
 */

import { readFileSync, writeFileSync } from "node:fs"
import process from "node:process"

import { CdpClient, wait } from "./perf/cdp.mjs"

const BRIDGE = process.env.OC_IOS_CDP ?? "http://127.0.0.1:9222"
const DEFAULT_TARGET = "[data-composer-morph-prompt]"

const args = process.argv.slice(2)
const command = args[0]
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const fail = (message) => {
  console.error(`profile:ios: ${message}`)
  process.exit(1)
}

const listTargets = async () => {
  try {
    return await (await fetch(`${BRIDGE}/json`)).json()
  } catch {
    fail(`no inspector bridge at ${BRIDGE}. Start it with: pymobiledevice3 webinspector cdp`)
  }
}

const connect = async () => {
  const page = (await listTargets()).find((target) => target.type === "page")
  if (!page) fail("the bridge lists no page: is the app open on the phone, and a Debug build?")
  const client = new CdpClient(page.webSocketDebuggerUrl)
  await client.connect()
  // WebKit over the bridge does not answer awaitPromise: expressions return
  // plain values, and async results are left on window and read later.
  const evaluate = async (expression) => {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs: 20_000 })
    // WebKit reports a throw as `wasThrown`, Chrome as `exceptionDetails`.
    if (result.exceptionDetails || result.wasThrown) fail(`the page threw: ${result.result?.description ?? JSON.stringify(result.exceptionDetails ?? result.result)}`)
    return result.result?.value
  }
  return { client, evaluate }
}

const BLUR = `(() => { const active = document.activeElement; if (active && active !== document.body) active.blur(); return true; })()`

const keyboard = async ({ evaluate }) => {
  const runs = Number(option("runs", 3))
  const setup = option("setup", "0")
  const teardown = option("teardown", "0")
  const target = JSON.stringify(option("target", DEFAULT_TARGET))
  const results = []
  for (let run = 0; run < runs; run++) {
    await evaluate(BLUR)
    await wait(1800)
    await evaluate(`(() => { ${setup}; return true; })()`)
    await wait(400)
    const tapped = await evaluate(`(() => {
      const element = document.querySelector(${target});
      if (!element) return false;
      const out = window.__ocIosKeyboard = { blocks: [], focusAt: null, keyboardAt: null, tapAt: performance.now() };
      const onFocus = () => {
        out.focusAt = performance.now() - out.tapAt;
        document.removeEventListener('focusin', onFocus, true);
        // A message loop measures how long the main thread stays busy.
        let last = performance.now();
        const start = last;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          const now = performance.now();
          if (now - last > 12) out.blocks.push({ at: Math.round(last - start), ms: Math.round(now - last) });
          last = now;
          if (now - start < 500) channel.port2.postMessage(0);
        };
        channel.port2.postMessage(0);
      };
      document.addEventListener('focusin', onFocus, true);
      window.addEventListener('oc:keyboard-anim', () => { out.keyboardAt = performance.now() - out.tapAt; }, { once: true });
      element.click();
      return true;
    })()`)
    if (!tapped) fail(`no element matches ${option("target", DEFAULT_TARGET)}`)
    await wait(1500)
    const result = await evaluate(`JSON.stringify(window.__ocIosKeyboard)`)
    await evaluate(`(() => { ${teardown}; return true; })()`)
    const { focusAt, keyboardAt, blocks } = JSON.parse(result)
    if (focusAt === null) fail(`run ${run + 1}: the tap never focused a field`)
    if (keyboardAt === null) fail(`run ${run + 1}: the keyboard never started (oc:keyboard-anim did not fire)`)
    results.push({ focusMs: Math.round(focusAt), keyboardMs: Math.round(keyboardAt), blocks })
  }
  await evaluate(BLUR)
  for (const result of results) console.log(JSON.stringify(result))
  const sorted = results.map((result) => result.keyboardMs).sort((a, b) => a - b)
  console.log(`tap → keyboard start: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms`)
}

const frames = async ({ evaluate }) => {
  const setup = option("setup", "0")
  const target = JSON.stringify(option("target", DEFAULT_TARGET))
  const durationMs = Number(option("ms", 2500))
  await evaluate(BLUR)
  await wait(1500)
  await evaluate(`(() => { ${setup}; return true; })()`)
  await wait(800)
  const started = await evaluate(`(() => {
    const element = document.querySelector(${target});
    if (!element) return false;
    const top = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? Math.round(rect.top * 10) / 10 : null;
    };
    const snap = (tag) => {
      const scroller = document.querySelector('.chat-scroll');
      const turns = scroller?.querySelectorAll('[data-turn-id]') ?? [];
      const last = turns[turns.length - 1]?.getBoundingClientRect();
      return {
        tag,
        t: Math.round(performance.now() - out.t0),
        composer: top('.oc-mobile-composer'),
        slot: top('[data-composer-slot]'),
        riders: top('[data-composer-riders]'),
        lastTurnBottom: last ? Math.round(last.bottom * 10) / 10 : null,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        scrollEnd: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
      };
    };
    const out = window.__ocIosFrames = { t0: performance.now(), log: [] };
    out.log.push(snap('before'));
    // From the tap on: the pill morphs before the keyboard event arrives.
    const end = out.t0 + ${durationMs};
    const loop = () => { out.log.push(snap('frame')); if (performance.now() < end) requestAnimationFrame(loop); };
    window.addEventListener('oc:keyboard-anim', () => { out.log.push(snap('keyboard-start')); }, { once: true });
    window.addEventListener('oc:keyboard-settled', () => { out.log.push(snap('keyboard-settled')); }, { once: true });
    element.click();
    requestAnimationFrame(loop);
    return true;
  })()`)
  if (!started) fail(`no element matches ${option("target", DEFAULT_TARGET)}`)
  await wait(durationMs + 500)
  const log = JSON.parse(await evaluate(`JSON.stringify(window.__ocIosFrames.log)`))
  await evaluate(BLUR)
  if (!log.some((entry) => entry.tag === "keyboard-start")) fail("the keyboard never started (oc:keyboard-anim did not fire)")
  let previous = null
  for (const entry of log) {
    const { tag, t, ...position } = entry
    const key = JSON.stringify(position)
    if (tag !== "frame" || key !== previous) console.log(JSON.stringify(entry))
    previous = key
  }
}

const domWeight = async ({ evaluate }) => {
  const min = Number(option("min", 800))
  const tree = await evaluate(`(() => {
    const out = [];
    const walk = (element, depth) => {
      const count = element.getElementsByTagName('*').length;
      if (count < ${min}) return;
      const name = element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (typeof element.className === 'string' && element.className ? '.' + element.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
      out.push('  '.repeat(depth) + name + ' [' + count + ']' + (getComputedStyle(element).display === 'none' ? ' display:none' : ''));
      for (const child of element.children) walk(child, depth + 1);
    };
    walk(document.body, 0);
    return out.join('\\n');
  })()`)
  console.log(tree || `no subtree of ${min} elements or more`)
}

const screenshot = async ({ client }) => {
  const out = option("out", "ios-screen.png")
  const shot = await client.send("Page.captureScreenshot", { format: "png" }, { timeoutMs: 20_000 })
  writeFileSync(out, Buffer.from(shot.data, "base64"))
  console.log(out)
}

if (command === undefined || command === "--help") {
  // The header comment is the usage text.
  const source = readFileSync(new URL(import.meta.url), "utf8")
  console.log(source.slice(source.indexOf("/**") + 3, source.indexOf("*/")).replace(/^ \* ?/gm, "").trim())
  process.exit(0)
}

if (command === "targets") {
  for (const target of await listTargets()) console.log(`${target.type}\t${target.title}\t${target.url}`)
  process.exit(0)
}

const commands = { keyboard, frames, "dom-weight": domWeight, screenshot }
if (command !== "eval" && !commands[command]) {
  fail("usage: profile:ios <targets|eval|keyboard|frames|dom-weight|screenshot> (see the header of scripts/profile-ios.mjs)")
}
const session = await connect()
try {
  if (command === "eval") console.log(JSON.stringify(await session.evaluate(args[1] ?? "undefined")))
  else await commands[command](session)
} finally {
  session.client.close()
}
process.exit(0)
