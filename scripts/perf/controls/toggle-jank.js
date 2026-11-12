// Positive control for profile:toggle, never part of a measured run. While any
// width transition runs, every animation frame busy-waits 25 ms and then
// forces a layout (writes a probe element's width, reads it back). A working
// instrument reads, on every toggle: dropped frames above zero, a worst frame
// of 25 ms or more, and forced layouts attributed to
// forceLayoutOnTransitionFrame.
//   bun run profile:toggle -- --url <url> --inject-script scripts/perf/controls/toggle-jank.js
(() => {
  let running = 0
  let probe = null
  let flip = false
  const forceLayoutOnTransitionFrame = () => {
    if (running === 0) return
    const startedAt = performance.now()
    while (performance.now() - startedAt < 25) { /* busy */ }
    flip = !flip
    probe.style.width = flip ? "1px" : "2px"
    void probe.offsetWidth
    requestAnimationFrame(forceLayoutOnTransitionFrame)
  }
  const isWidth = (event) => event.propertyName === "width"
  document.addEventListener("DOMContentLoaded", () => {
    probe = document.createElement("div")
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;height:1px;width:1px;pointer-events:none"
    document.body.appendChild(probe)
  })
  document.addEventListener("transitionrun", (event) => {
    if (!isWidth(event)) return
    running += 1
    if (running === 1) requestAnimationFrame(forceLayoutOnTransitionFrame)
  }, true)
  const stop = (event) => { if (isWidth(event)) running = Math.max(0, running - 1) }
  document.addEventListener("transitionend", stop, true)
  document.addEventListener("transitioncancel", stop, true)
})()
