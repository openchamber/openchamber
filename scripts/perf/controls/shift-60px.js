// Positive control for profile:switch's shift metric, never part of a measured
// run. 300 ms after each timeline reveal finishes, it pushes the last on-screen
// message down 60 px with a margin, the way a late layout change would. A
// working instrument reads shift.maxPx near 60 on every switch (or scroll
// changes, when the list compensates).
//   bun run profile:switch -- --url <url> --inject-script scripts/perf/controls/shift-60px.js
(() => {
  let armed = false
  const onMutation = () => {
    if (document.querySelector("[data-timeline-reveal]")) { armed = true; return }
    if (!armed) return
    armed = false
    setTimeout(() => {
      const target = [...document.querySelectorAll("[data-message-id]")]
        .filter((element) => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight })
        .at(-1)
      if (target) target.style.marginTop = "60px"
    }, 300)
  }
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(onMutation).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-timeline-reveal"] })
  })
})()
