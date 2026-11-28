import tailwindcss from "@tailwindcss/postcss"

const opaqueTextBackdrop = {
  postcssPlugin: "opaque-text-backdrop",
  OnceExit(root) {
    root.walkDecls("color", (decl) => {
      if (decl.value.startsWith("color-mix(")) {
        decl.value = decl.value.replace(/,\s*transparent\)/g, ", var(--oc-text-backdrop, transparent))")
      }
    })
  },
}

export default {
  plugins: [tailwindcss(), opaqueTextBackdrop],
}