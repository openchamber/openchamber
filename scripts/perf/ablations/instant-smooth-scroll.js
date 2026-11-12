// Ablation: smooth scrollTo calls jump instantly, removing the animated frames
// of the chat's follow glide. Measures what smooth scrolling costs while text
// streams. Attribution only: inject with --inject-script.
(() => {
  const scrollTo = Element.prototype.scrollTo
  Element.prototype.scrollTo = function instantScrollTo(first, second) {
    if (first?.behavior === "smooth") return scrollTo.call(this, { ...first, behavior: "instant" })
    return scrollTo.call(this, first, second)
  }
})()
