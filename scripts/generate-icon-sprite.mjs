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

const customIconData = new Map([
  [
    "openchamber",
    `<polygon points="12 2.5 3.5 7.4 3.5 17.2 12 22.1 20.5 17.2 20.5 7.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="3.5 7.4 12 12.3 20.5 7.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="12.3" x2="12" y2="22.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m12 5.5 3.7 2.1L12 9.7 8.3 7.6 12 5.5Zm0 1.5-1 .6 1 .6 1-.6-1-.6Z" fill="currentColor" fill-rule="evenodd"/>`,
  ],
  // Claude spark — official Anthropic mark (Simple Icons path), monochrome.
  [
    "claude-code",
    `<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="currentColor"/>`,
  ],
  // Cursor two-cursor mark — official (Simple Icons path), monochrome.
  [
    "cursor",
    `<path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" fill="currentColor"/>`,
  ],
  // Command Code — corner squares + center square (official logo geometry).
  [
    "command-code",
    `<path fill="currentColor" d="M5.8 5.8h4.8v4.8h-4.8Z M13.4 5.8h4.8v4.8h-4.8Z M10.6 10.6h2.8v2.8h-2.8Z M5.8 13.4h4.8v4.8h-4.8Z M13.4 13.4h4.8v4.8h-4.8Z"/>`,
  ],
  // Linear logo, adapted from the supplied 100x100 mark to the 24x24 sprite viewBox.
  [
    "linear",
    `<g transform="translate(1.5 1.5) scale(0.21)"><path fill="currentColor" d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6686-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z"/></g>`,
  ],
  // Cloudflare logo, reduced to a single currentColor silhouette.
  [
    "cloudflare",
    `<g transform="translate(0.2 0.2) scale(0.18)"><path fill="currentColor" d="M87.295 89.022c.763-2.617.472-5.015-.8-6.796-1.163-1.635-3.125-2.58-5.488-2.689l-44.737-.581c-.291 0-.545-.145-.691-.363s-.182-.509-.109-.8c.145-.436.581-.763 1.054-.8l45.137-.581c5.342-.254 11.157-4.579 13.192-9.885l2.58-6.723c.109-.291.145-.581.073-.872-2.906-13.158-14.644-22.97-28.672-22.97-12.938 0-23.913 8.359-27.838 19.952a13.35 13.35 0 0 0-9.267-2.58c-6.215.618-11.193 5.597-11.811 11.811-.145 1.599-.036 3.162.327 4.615C10.104 70.051 2 78.337 2 88.549c0 .909.073 1.817.182 2.726a.895.895 0 0 0 .872.763h82.57c.472 0 .909-.327 1.054-.8l.617-2.216z"/><path fill="currentColor" d="M101.542 60.275c-.4 0-.836 0-1.236.036-.291 0-.545.218-.654.509l-1.744 6.069c-.763 2.617-.472 5.015.8 6.796 1.163 1.635 3.125 2.58 5.488 2.689l9.522.581c.291 0 .545.145.691.363.145.218.182.545.109.8-.145.436-.581.763-1.054.8l-9.924.582c-5.379.254-11.157 4.579-13.192 9.885l-.727 1.853c-.145.363.109.727.509.727h34.089c.4 0 .763-.254.872-.654.581-2.108.909-4.325.909-6.614 0-13.447-10.975-24.422-24.458-24.422"/></g>`,
  ],
])

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
const usedCustomIcons = new Set()
const addKebabIcon = (kebab) => {
  if (customIconData.has(kebab)) {
    usedCustomIcons.add(kebab)
    return true
  }

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

for (const iconName of [...usedCustomIcons].sort()) {
  iconEntries.push({ name: iconName, content: customIconData.get(iconName) })
}

// --- Step 5: write sprite.ts ---
const spriteLines = iconEntries
  .map(({ name, content }) => ({
    name: name.startsWith("Ri") ? remixToSpriteName(name) : name,
    content,
  }))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map(({ name, content }) => `  "${name}": \`${content}\`,`)

const spriteContent = `// This file is auto-generated by scripts/generate-icon-sprite.mjs
// Do not edit manually. Run the script to update.

export const iconSpriteData = {
${spriteLines.join("\n")}
} as const satisfies Record<string, string>;
`

writeFileSync(outPath, spriteContent, "utf-8")
console.log(`\n✅ Generated sprite data for ${iconEntries.length} icons → ${outPath}`)
console.log(`   Total sprite size: ${Buffer.byteLength(spriteContent).toLocaleString()} bytes`)
