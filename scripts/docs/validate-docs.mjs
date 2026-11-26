import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "..", "..")
// An optional argument points the check at another docs folder (the tests).
const docsRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "packages", "docs")
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

// Root-relative links in a page body: Markdown `[text](/page/)` and
// `[text](</page/>)`, reference definitions `[name]: /page/`, and JSX
// `href="/page/"`. Code fences (also indented ones inside list items) and
// inline code are skipped, so examples of links never count as links.
function bodyLinks(content) {
  const prose = content
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
  const links = []
  const pattern =
    /\]\(<(\/[^>\n]*)>|\]\((\/[^)\s]*)(?:\s+"[^"]*")?\)|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?(\/[^>\s]*)>?|href=["'](\/[^"']*)["']/gm
  for (const hit of prose.matchAll(pattern)) {
    links.push(hit[1] ?? hit[2] ?? hit[3] ?? hit[4])
  }
  return links
}

// The page route a link points at, or null for links outside the docs pages
// (an asset with a file extension, a protocol-relative URL). Dot segments
// resolve the way a browser resolves them.
function linkRoute(link) {
  if (link.startsWith("//")) return null
  const pathname = new URL(link, "https://docs.invalid").pathname
  if (/\.[a-z0-9]+$/i.test(pathname)) return null
  if (pathname === "" || pathname === "/") return "/"
  return pathname.endsWith("/") ? pathname : `${pathname}/`
}

async function run() {
  const filePaths = (await walk(contentRoot)).filter((p) => p.endsWith(".mdx"))
  const routeSet = new Set()
  const errors = []
  const pageLinks = []

  for (const filePath of filePaths) {
    const body = await readFile(filePath, "utf8")
    const relative = toPosix(path.relative(repoRoot, filePath))
    const route = routeFromFile(filePath)
    routeSet.add(route)
    for (const link of bodyLinks(body)) pageLinks.push({ relative, link })

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

  for (const { relative, link } of pageLinks) {
    const target = linkRoute(link)
    if (target !== null && !routeSet.has(target)) {
      errors.push(`${relative}: link has no page: ${link}`)
    }
  }

  if (errors.length > 0) {
    console.error("Docs validation failed:")
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log(
    `Docs validation passed: ${filePaths.length} pages, ${links.length} sidebar links, ${pageLinks.length} page links.`,
  )
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
