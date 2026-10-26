// Ablation: every Web Animations API call (motion, framer-style libraries)
// finishes at once. Measures what JS-driven animations cost.
// Attribution only: inject with --inject-script; the run describes a modified app.
(() => {
  const animate = Element.prototype.animate
  Element.prototype.animate = function instantAnimate(keyframes, options) {
    const instant = Number.isFinite(options) ? { duration: 0 } : { ...options, duration: 0, delay: 0 }
    return animate.call(this, keyframes, instant)
  }
})()
