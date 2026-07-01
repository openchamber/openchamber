/**
 * Generates the SVG icon sprite file from @remixicon/react bundle.
 *
 * Usage: bun run scripts/generate-icon-sprite.mjs
 *
 * Reads the minified @remixicon/react bundle, extracts SVG path data
 * for all Ri* icons used in packages/ui/src, and writes
 * packages/ui/src/components/icon/sprite.ts.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..")
const remixPath = resolve(repoRoot, "node_modules/@remixicon/react/index.mjs")
const outPath = resolve(repoRoot, "packages/ui/src/components/icon/sprite.ts")

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

const spriteNameToRi = new Map()
const hasRemixVariantSuffix = (name) => name.endsWith("Line") || name.endsWith("Fill")
const shouldPreferSpriteCandidate = (current, candidate) => {
  if (!current) return true
  if (!hasRemixVariantSuffix(candidate) && hasRemixVariantSuffix(current)) return true
  if (!hasRemixVariantSuffix(current)) return false
  if (candidate.endsWith("Line") && !current.endsWith("Line")) return true
  return false
}

for (const iconName of nameToVar.keys()) {
  const spriteName = remixToSpriteName(iconName)
  const current = spriteNameToRi.get(spriteName)
  if (shouldPreferSpriteCandidate(current, iconName)) {
    spriteNameToRi.set(spriteName, iconName)
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

// Finish step 3 synchronously with simpler approach
function findAllSourceFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === "node_modules") continue
        results.push(...findAllSourceFiles(full))
      } else if (/\.(tsx?)$/.test(entry) && full !== outPath) {
        results.push(full)
      }
    } catch { /* skip */ }
  }
  return results
}

const allSrcFiles = findAllSourceFiles(srcDir)
const usedIcons = new Set()
const addKebabIcon = (kebab) => {
  const exactRiName = spriteNameToRi.get(kebab)
  if (exactRiName && !hasRemixVariantSuffix(exactRiName)) {
    usedIcons.add(exactRiName)
    return true
  }

  for (const suffix of ["Line", "Fill", ""]) {
    const riName = nameToRi(kebab) + suffix
    if (nameToVar.has(riName)) {
      usedIcons.add(riName)
      return true
    }
  }

  if (exactRiName) {
    usedIcons.add(exactRiName)
    return true
  }

  return false
}

const addIconLiterals = (content) => {
  const iconLiteralRegex = /["']([a-z][a-z0-9-]*)["']/g
  let literal
  while ((literal = iconLiteralRegex.exec(content)) !== null) {
    addKebabIcon(literal[1])
  }
}

function findMatchingBrace(content, openBraceIndex) {
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]

    if (lineComment) {
      if (char === "\n") lineComment = false
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        i++
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "/" && next === "/") {
      lineComment = true
      i++
      continue
    }

    if (char === "/" && next === "*") {
      blockComment = true
      i++
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (char === "{") {
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

const addIconNameFunctionReturns = (content) => {
  const functionRegex = /function\s+\w+\s*\([^)]*\)\s*:\s*IconName(?:\s*\|\s*null)?\s*{/g
  let match
  while ((match = functionRegex.exec(content)) !== null) {
    const openBraceIndex = content.indexOf("{", match.index)
    if (openBraceIndex === -1) continue

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) continue

    const body = content.slice(openBraceIndex + 1, closeBraceIndex)
    const returnRegex = /\breturn\s+["']([a-z][a-z0-9-]*)["']/g
    let returnMatch
    while ((returnMatch = returnRegex.exec(body)) !== null) {
      addKebabIcon(returnMatch[1])
    }
    functionRegex.lastIndex = closeBraceIndex + 1
  }
}

const addTypedIconNameRecords = (content) => {
  const recordRegex = /:\s*Record<[^>]*IconName[^>]*>\s*=\s*{/g
  let match
  while ((match = recordRegex.exec(content)) !== null) {
    const openBraceIndex = content.indexOf("{", match.index)
    if (openBraceIndex === -1) continue

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) continue

    addIconLiterals(content.slice(openBraceIndex + 1, closeBraceIndex))
    recordRegex.lastIndex = closeBraceIndex + 1
  }
}

const addIconNameVariableAssignments = (content) => {
  if (!/<Icon\b/.test(content)) return

  const variableRegex = /\b(?:const|let|var)\s+\w*IconName\b[^=]*=\s*([\s\S]*?);/g
  let match
  while ((match = variableRegex.exec(content)) !== null) {
    const initializer = match[1]
    const directLiteral = /^\s*["']([a-z][a-z0-9-]*)["']/.exec(initializer)
    if (directLiteral) {
      addKebabIcon(directLiteral[1])
    }

    const branchLiteralRegex = /(?:\?\?|[?:])\s*["']([a-z][a-z0-9-]*)["']/g
    let branchLiteral
    while ((branchLiteral = branchLiteralRegex.exec(initializer)) !== null) {
      addKebabIcon(branchLiteral[1])
    }
  }
}

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
  const iconNameRegex = /<Icon\b[^>]*\bname=(?:["']([^"']+)["']|{\s*["']([^"']+)["']\s*})/g
  let nm
  while ((nm = iconNameRegex.exec(content)) !== null) {
    addKebabIcon(nm[1] || nm[2])
  }

  // Also scan for icon: 'kebab-name' / Icon: 'kebab-name' in object literals.
  const iconPropRegex = /\b[Ii]con:\s*["']([a-z][a-z0-9-]*)["']/g
  let ip
  while ((ip = iconPropRegex.exec(content)) !== null) {
    addKebabIcon(ip[1])
  }

  // Also scan JSX props named icon/Icon with a string literal value.
  const iconJsxPropRegex = /\b[Ii]con=(?:["']([^"']+)["']|{\s*["']([^"']+)["']\s*})/g
  let jp
  while ((jp = iconJsxPropRegex.exec(content)) !== null) {
    addKebabIcon(jp[1] || jp[2])
  }

  addIconNameFunctionReturns(content)
  addTypedIconNameRecords(content)
  addIconNameVariableAssignments(content)
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
const spriteLines = iconEntries.map(({ name, content }) => {
  const spriteName = remixToSpriteName(name)
  return `  "${spriteName}": \`${content}\`,`
})

const spriteContent = `// This file is auto-generated by scripts/generate-icon-sprite.mjs
// Do not edit manually. Run the script to update.

export const iconSpriteData = {
${spriteLines.join("\n")}
} as const satisfies Record<string, string>;
`

writeFileSync(outPath, spriteContent, "utf-8")
console.log(`\n✅ Generated sprite data for ${iconEntries.length} icons → ${outPath}`)
console.log(`   Total sprite size: ${Buffer.byteLength(spriteContent).toLocaleString()} bytes`)
