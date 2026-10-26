import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "..", "..")
const docsRoot = path.join(repoRoot, "packages", "docs")
const contentRoot = path.join(docsRoot, "content", "docs")
const sidebarPath = path.join(docsRoot, "sidebar.config.json")

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(target)
      return [target]
    }),
  )
  return files.flat()
}

function toPosix(value) {
  return value.split(path.sep).join("/")
}

function routeFromFile(filePath) {
  const relative = toPosix(path.relative(contentRoot, filePath))
  const withoutExt = relative.replace(/\.mdx$/, "")

  if (withoutExt === "index") return "/"
  if (withoutExt.endsWith("/index")) {
    return `/${withoutExt.slice(0, -"/index".length)}/`
  }

  return `/${withoutExt}/`
}

function hasFrontmatterKey(content, key) {
  const hit = /^---\n([\s\S]*?)\n---\n/m.exec(content)
  if (!hit) return false
  return new RegExp(`^${key}:\\s*.+$`, "m").test(hit[1])
}

async function run() {
  const filePaths = (await walk(contentRoot)).filter((p) => p.endsWith(".mdx"))
  const routeSet = new Set()
  const errors = []

  for (const filePath of filePaths) {
    const body = await readFile(filePath, "utf8")
    const relative = toPosix(path.relative(repoRoot, filePath))
    const route = routeFromFile(filePath)
    routeSet.add(route)

    if (!hasFrontmatterKey(body, "title")) {
      errors.push(`${relative}: missing frontmatter key 'title'`)
    }
    if (!hasFrontmatterKey(body, "description")) {
      errors.push(`${relative}: missing frontmatter key 'description'`)
    }
  }

  const sidebarRaw = await readFile(sidebarPath, "utf8")
  const sidebar = JSON.parse(sidebarRaw)
  const links = (sidebar.sections ?? [])
    .flatMap((section) => section.items ?? [])
    .map((item) => item.link)

  for (const link of links) {
    if (!routeSet.has(link)) {
      errors.push(`sidebar link has no page: ${link}`)
    }
  }

  if (errors.length > 0) {
    console.error("Docs validation failed:")
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log(`Docs validation passed: ${filePaths.length} pages, ${links.length} sidebar links.`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
