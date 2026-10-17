// Positive control for profile:idle's frame count, never part of a measured
// run. It adds one dot with an infinite opacity pulse, the kind of composited
// animation that costs the main thread nothing. A working instrument reads
// about 60 frames drawn per second, and --budget-frames fails.
//   bun run profile:idle -- --url <url> --budget-frames 3 --inject-script scripts/perf/controls/pulse-dot.js
(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style")
    style.textContent = "@keyframes perf-control-pulse { 50% { opacity: 0.2 } }"
      + " .perf-control-pulse { position: fixed; right: 8px; bottom: 8px; width: 8px; height: 8px;"
      + " border-radius: 50%; background: currentColor; animation: perf-control-pulse 1.2s ease-in-out infinite; }"
    document.head.appendChild(style)
    const dot = document.createElement("div")
    dot.className = "perf-control-pulse"
    document.body.appendChild(dot)
  })
})()
