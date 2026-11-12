// Ablation: no CSS animation or transition runs anywhere on the page, and Web
// Animations finish at once. The upper bound of what all motion costs; when it
// moves the number, narrow it down with --inject-css on one selector.
// Attribution only: inject with --inject-script.
(() => {
  const animate = Element.prototype.animate
  Element.prototype.animate = function instantAnimate(keyframes, options) {
    const instant = Number.isFinite(options) ? { duration: 0 } : { ...options, duration: 0, delay: 0 }
    return animate.call(this, keyframes, instant)
  }
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style")
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }"
    document.head.appendChild(style)
  })
})()
