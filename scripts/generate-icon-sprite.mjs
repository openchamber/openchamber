/**
 * Generates the SVG icon sprite file from @remixicon/react bundle.
 *
 * Usage: bun run scripts/generate-icon-sprite.mjs
 *
 * Reads the minified @remixicon/react bundle, extracts SVG path data
 * for all Ri* icons used in packages/ui/src, and writes
 * packages/ui/src/components/icon/sprite.ts.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..")
const remixPath = resolve(repoRoot, "node_modules/@remixicon/react/index.mjs")

const source = readFileSync(remixPath, "utf-8")

// --- Step 1: extract variable → path mapping ---
// Pattern: const VARNAME=({color:...})=>...createElement("path",{d:"PATH_DATA"})...,
// Each icon is defined as `const X=...` where X is 1-4 chars.
const varPathMap = new Map()
const varRegex = /(?:[,;]const |\),)([A-Za-z0-9_$]{1,4})=\([{]color:/g
// Find all variable definitions and their boundaries
const varPositions = []
let m
while ((m = varRegex.exec(source)) !== null) {
  varPositions.push({
    varName: m[1],
    start: m.index + m[0].length - 1, // first `{` after `=({color:`
  })
}

for (let i = 0; i < varPositions.length; i++) {
  const current = varPositions[i]
  const next = varPositions[i + 1]
  // End at the )), just before the next variable definition
  const end = next
    ? source.indexOf("))," + next.varName + "=(", current.start)
    : source.length
  if (end < 0 || end < current.start) continue
  const segment = source.slice(current.start, end)
  const pathRegex = /\w+\.createElement\("path",[{]d:"([^"]*)"/g
  let pm
  const paths = []
  while ((pm = pathRegex.exec(segment)) !== null) {
    paths.push(pm[1])
  }
  if (paths.length > 0) {
    varPathMap.set(current.varName, paths)
  }
}

// --- Step 2: extract export mapping ---
// The export map is near the end of the file:
// export{V1 as Ri...Z2 as RiLast};
const exportRegex = /export[{]([^}]+)[}]/
const exportMatch = exportRegex.exec(source)
if (!exportMatch) {
  console.error("Could not find export mapping in remixicon bundle")
  process.exit(1)
}

const nameToVar = new Map()
const entries = exportMatch[1].split(",")
for (const entry of entries) {
  // Pattern: VAR as RiIconName
  const parts = entry.trim().split(" as ")
  if (parts.length === 2) {
    nameToVar.set(parts[1].trim(), parts[0].trim())
  }
}

// --- Step 3: find which icons we actually use ---
const srcDir = resolve(repoRoot, "packages/ui/src")

// Helper: convert kebab-case name back to RiName
function nameToRi(kebab) {
  // "arrow-down-sline" → RiArrowDownSline
  const parts = kebab.split("-")
  let result = "Ri"
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i > 0 && /^\d/.test(part)) {
      result += part[0].toUpperCase() + part.slice(1)
    } else {
      result += part.charAt(0).toUpperCase() + part.slice(1)
    }
  }
  return result
}

const srcFiles = []
function walk(dir) {
  const { readdirSync, statSync } = require("node:fs")
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue
      walk(full)
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      srcFiles.push(full)
    }
  }
}
import("node:fs").then(({ readdirSync, statSync: st }) => {
  // Already imported above, use recursive function
  function localWalk(dir) {
    const { readdirSync: rd, statSync: s } = require("node:fs")
    for (const entry of rd(dir)) {
      const full = resolve(dir, entry)
      try {
        if (s(full).isDirectory()) {
          if (entry === "node_modules") continue
          localWalk(full)
        } else if (/\.(tsx?)$/.test(entry)) {
          srcFiles.push(full)
        }
      } catch {}
    }
  }
  localWalk(srcDir)
})

// Finish step 3 synchronously with simpler approach
import { readdirSync, statSync } from "node:fs"
function findAllSourceFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === "node_modules") continue
        results.push(...findAllSourceFiles(full))
      } else if (/\.(tsx?)$/.test(entry)) {
        results.push(full)
      }
    } catch { /* skip */ }
  }
  return results
}

// Helper: convert kebab-case name back to RiX name
function nameToRi(kebab) {
  const parts = kebab.split("-")
  let result = "Ri"
  for (let i = 0; i < parts.length; i++) {
    result += parts[i].charAt(0).toUpperCase() + parts[i].slice(1)
  }
  return result
}

const allSrcFiles = findAllSourceFiles(srcDir)
const usedIcons = new Set()
for (const file of allSrcFiles) {
  const content = readFileSync(file, "utf-8")
  // Match RiIcons from @remixicon/react imports
  const iconRegex = /Ri[A-Z][A-Za-z0-9]+/g
  let im
  while ((im = iconRegex.exec(content)) !== null) {
    if (nameToVar.has(im[0])) {
      usedIcons.add(im[0])
    }
  }

  // Also scan for <Icon name="..." /> patterns (already-migrated icons)
  const iconNameRegex = /Icon\s+name="([^"]+)"/g
  let nm
  while ((nm = iconNameRegex.exec(content)) !== null) {
    const kebab = nm[1]
    for (const suffix of ["Line", "Fill", ""]) {
      const riName = nameToRi(kebab) + suffix
      if (nameToVar.has(riName)) {
        usedIcons.add(riName)
        break
      }
    }
  }

  // Also scan for icon: 'kebab-name' in object literals (e.g. MODALITY_ICON_MAP)
  const iconPropRegex = /icon:\s*'([a-z][a-z0-9-]*)'/g
  let ip
  while ((ip = iconPropRegex.exec(content)) !== null) {
    const kebab = ip[1]
    for (const suffix of ["Line", "Fill", ""]) {
      const riName = nameToRi(kebab) + suffix
      if (nameToVar.has(riName)) {
        usedIcons.add(riName)
        break
      }
    }
  }
}

console.log(`Found ${usedIcons.size} unique remixicon names used in source`)

// --- Step 4: build sprite data ---
const iconEntries = []
for (const iconName of [...usedIcons].sort()) {
  const varName = nameToVar.get(iconName)
  if (!varName) {
    console.warn(`  ⚠ Unknown icon: ${iconName}`)
    continue
  }
  const paths = varPathMap.get(varName)
  if (!paths || paths.length === 0) {
    console.warn(`  ⚠ No path data for: ${iconName} (var: ${varName})`)
    continue
  }

  // Build SVG content from paths
  const svgContent = paths
    .map((d) => `<path d="${d}" fill="currentColor"/>`)
    .join("")

  iconEntries.push({ name: iconName, content: svgContent })
}

// --- Step 5: write sprite.ts ---
const remixToSpriteName = (name) => {
  // RiArrowDownSLine → arrow-down-s
  // RiGithubFill → github-fill (keep Fill for fill variants)
  return name
    .replace(/^Ri/, "")
    .replace(/Line$/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
}

const spriteLines = iconEntries.map(({ name, content }) => {
  const spriteName = remixToSpriteName(name)
  return `  "${spriteName}": \`${content}\`,`
})

const spriteContent = `// This file is auto-generated by scripts/generate-icon-sprite.mjs
// Do not edit manually. Run the script to update.

export const iconSpriteData: Record<string, string> = {
${spriteLines.join("\n")}
};
`

const outPath = resolve(repoRoot, "packages/ui/src/components/icon/sprite.ts")
writeFileSync(outPath, spriteContent, "utf-8")
console.log(`\n✅ Generated sprite data for ${iconEntries.length} icons → ${outPath}`)
console.log(`   Total sprite size: ${Buffer.byteLength(spriteContent).toLocaleString()} bytes`)
