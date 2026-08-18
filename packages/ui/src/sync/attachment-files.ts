const ACCEPTED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".cts",
  ".dart",
  ".diff",
  ".docx",
  ".drawio",
  ".env",
  ".erl",
  ".ex",
  ".exs",
  ".fs",
  ".fsx",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".har",
  ".hh",
  ".hcl",
  ".heic",
  ".heif",
  ".hpp",
  ".hrl",
  ".htm",
  ".html",
  ".ini",
  ".ipynb",
  ".java",
  ".jl",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".kts",
  ".log",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".ndjson",
  ".odp",
  ".ods",
  ".odt",
  ".patch",
  ".php",
  ".proto",
  ".pptx",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sol",
  ".sql",
  ".svelte",
  ".svg",
  ".swift",
  ".tf",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".xlsx",
  ".yaml",
  ".yml",
  ".zig",
  ".zsh",
] as const

export const ATTACHMENT_ACCEPT = ACCEPTED_ATTACHMENT_TYPES.join(",")

const PICKER_MIME_EXTENSIONS = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/json", "json"],
  ["application/ld+json", "jsonld"],
  ["application/toml", "toml"],
  ["application/x-toml", "toml"],
  ["application/x-yaml", "yaml"],
  ["application/xml", "xml"],
  ["application/yaml", "yaml"],
])
const TEXT_ATTACHMENT_EXTENSIONS = ["txt", "text", "md", "markdown", "log", "csv"]

export const ACCEPTED_ATTACHMENT_EXTENSIONS = Array.from(new Set(
  ACCEPTED_ATTACHMENT_TYPES.flatMap((type) => {
    if (type.startsWith(".")) return [type.slice(1)]
    if (type === "text/*") return TEXT_ATTACHMENT_EXTENSIONS
    const extension = PICKER_MIME_EXTENSIONS.get(type)
    return extension ? [extension] : []
  })
)).sort()

type OpenCodeAttachmentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/plain"

export type AttachmentInputModality = "text" | "image" | "pdf" | "audio" | "video"

export const getAttachmentInputModality = (mimeType: string): AttachmentInputModality | undefined => {
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? ""
  if (normalizedMimeType.startsWith("image/")) return "image"
  if (normalizedMimeType.startsWith("audio/")) return "audio"
  if (normalizedMimeType.startsWith("video/")) return "video"
  if (normalizedMimeType === "application/pdf") return "pdf"
  if (normalizedMimeType.startsWith("text/")) return "text"
  return undefined
}

export const getUnsupportedAttachmentInputs = <T extends { mimeType: string }>(
  attachments: T[],
  supportedInputModalities: string[],
): Array<{ attachment: T; modality: AttachmentInputModality }> => {
  const supportedModalities = new Set(supportedInputModalities.map((modality) => modality.toLowerCase()))
  const unsupportedInputs: Array<{ attachment: T; modality: AttachmentInputModality }> = []
  for (const attachment of attachments) {
    const modality = getAttachmentInputModality(attachment.mimeType)
    if (modality && !supportedModalities.has(modality)) {
      unsupportedInputs.push({ attachment, modality })
    }
  }
  return unsupportedInputs
}

const SUPPORTED_BINARY_MIMES = new Map<string, OpenCodeAttachmentMimeType>([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["application/pdf", "application/pdf"],
])
const SUPPORTED_BINARY_EXTENSIONS = new Map<string, OpenCodeAttachmentMimeType>([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
])
const ATTACHMENT_SAMPLE_BYTES = 4096
const DOCUMENT_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods"])
const REDACTED = "[REDACTED]"
const OMITTED = "[OMITTED BY OPENCHAMBER]"
const SENSITIVE_NAMES = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|client[-_]?secret|password|secret|access[-_]?token|refresh[-_]?token|id[-_]?token|token)$/i

type PreparedAttachmentFile = {
  file: File
  mimeType: string
}

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf(".")
  return index === -1 ? "" : name.slice(index + 1).toLowerCase()
}

const declaredMimeOf = (file: File): string => file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""

const inspectTextContent = async (file: File): Promise<"text/plain" | undefined> => {
  const bytes = new Uint8Array(await file.slice(0, ATTACHMENT_SAMPLE_BYTES).arrayBuffer())
  if (bytes.some((byte) => byte === 0)) return
  const controlBytes = bytes.filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length
  if (bytes.length > 0 && controlBytes / bytes.length > 0.3) return
  return "text/plain"
}

const attachmentMime = (
  file: File,
): OpenCodeAttachmentMimeType | Promise<"text/plain" | undefined> | undefined => {
  const type = declaredMimeOf(file)
  const supportedMime = SUPPORTED_BINARY_MIMES.get(type)
  if (supportedMime) return supportedMime

  const extension = extensionOf(file.name)
  const fallback = SUPPORTED_BINARY_EXTENSIONS.get(extension)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (type.startsWith("text/") || TEXT_MIMES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) {
    return "text/plain"
  }

  return inspectTextContent(file)
}

const sourceText = (source: unknown): string => {
  if (typeof source === "string") return source
  if (Array.isArray(source)) return source.filter((line): line is string => typeof line === "string").join("")
  return ""
}

const notebookText = (value: unknown, filename: string): string | undefined => {
  if (!value || typeof value !== "object") return
  const notebook = value as { cells?: unknown; metadata?: { kernelspec?: { language?: unknown } } }
  if (!Array.isArray(notebook.cells)) return
  const language = typeof notebook.metadata?.kernelspec?.language === "string"
    ? notebook.metadata.kernelspec.language
    : ""
  const sections = [`# Notebook: ${filename}`]

  notebook.cells.forEach((rawCell, index) => {
    if (!rawCell || typeof rawCell !== "object") return
    const cell = rawCell as { cell_type?: unknown; source?: unknown; outputs?: unknown }
    const content = sourceText(cell.source).trimEnd()
    if (cell.cell_type === "markdown") {
      sections.push(`## Markdown cell ${index + 1}\n\n${content}`)
      return
    }
    if (cell.cell_type !== "code") return

    sections.push(`## Code cell ${index + 1}\n\n\`\`\`${language}\n${content}\n\`\`\``)
    if (!Array.isArray(cell.outputs)) return
    const outputs: string[] = []
    for (const rawOutput of cell.outputs) {
      if (!rawOutput || typeof rawOutput !== "object") continue
      const output = rawOutput as { text?: unknown; traceback?: unknown; data?: unknown; ename?: unknown; evalue?: unknown }
      const text = sourceText(output.text) || sourceText(output.traceback)
      if (text) {
        outputs.push(text.trimEnd())
        continue
      }
      if (output.data && typeof output.data === "object") {
        const data = output.data as Record<string, unknown>
        const plain = sourceText(data["text/plain"])
        if (plain) outputs.push(plain.trimEnd())
        const omitted = Object.keys(data).filter((type) => type !== "text/plain")
        if (omitted.length > 0) outputs.push(`[Non-text output omitted: ${omitted.join(", ")}]`)
        continue
      }
      if (typeof output.ename === "string" || typeof output.evalue === "string") {
        outputs.push(`${String(output.ename ?? "Error")}: ${String(output.evalue ?? "")}`.trimEnd())
      }
    }
    if (outputs.length > 0) sections.push(`### Output\n\n${outputs.join("\n\n")}`)
  })

  return `${sections.join("\n\n")}\n`
}

const redactUrl = (value: string): string => {
  try {
    const url = new URL(value)
    for (const name of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_NAMES.test(name)) url.searchParams.set(name, REDACTED)
    }
    return url.toString()
  } catch {
    return value
  }
}

const sanitizeHarValue = (value: unknown, key?: string): unknown => {
  if (key && SENSITIVE_NAMES.test(key)) return REDACTED
  if (key === "cookies" && Array.isArray(value)) {
    return value.map((cookie) => {
      if (!cookie || typeof cookie !== "object") return cookie
      return { ...(cookie as Record<string, unknown>), value: REDACTED }
    })
  }
  if (key === "text" || key === "encoding") return OMITTED
  if (typeof value === "string") return key === "url" ? redactUrl(value) : value
  if (Array.isArray(value)) return value.map((item) => sanitizeHarValue(item))
  if (!value || typeof value !== "object") return value

  const record = value as Record<string, unknown>
  const sensitiveEntry = typeof record.name === "string" && SENSITIVE_NAMES.test(record.name)
  return Object.fromEntries(Object.entries(record).map(([entryKey, entryValue]) => [
    entryKey,
    sensitiveEntry && entryKey === "value" ? REDACTED : sanitizeHarValue(entryValue, entryKey),
  ]))
}

const prepareStructuredText = async (file: File, extension: string): Promise<File | undefined> => {
  const text = await file.text()
  if (extension === "har") {
    try {
      const sanitized = sanitizeHarValue(JSON.parse(text))
      return new File([`${JSON.stringify(sanitized, null, 2)}\n`], file.name, { type: "text/plain" })
    } catch {
      return
    }
  }
  if (extension === "ipynb") {
    try {
      const rendered = notebookText(JSON.parse(text), file.name)
      if (rendered) return new File([rendered], file.name, { type: "text/plain" })
    } catch {
      // Invalid notebooks can still be useful as plain text.
    }
  }
  return new File([text], file.name, { type: "text/plain" })
}

const convertHeicToJpeg = async (file: File): Promise<File | undefined> => {
  try {
    const heic2any = (await import("heic2any")).default
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 })
    const blob = Array.isArray(converted) ? converted[0] : converted
    if (!blob) return
    const filename = file.name.replace(/\.(heic|heif)$/i, ".jpg")
    return new File([blob], filename, { type: "image/jpeg" })
  } catch (error) {
    console.warn("Failed to convert HEIC attachment to JPEG", error)
    return
  }
}

export const prepareAttachmentFile = (
  file: File,
): PreparedAttachmentFile | Promise<PreparedAttachmentFile | undefined> | undefined => {
  const extension = extensionOf(file.name)
  const type = declaredMimeOf(file)
  if (type === "image/heic" || type === "image/heif" || extension === "heic" || extension === "heif") {
    return convertHeicToJpeg(file).then((converted) => converted
      ? { file: converted, mimeType: "image/jpeg" }
      : undefined)
  }
  if (extension === "har" || extension === "ipynb") {
    return prepareStructuredText(file, extension).then((prepared) => prepared
      ? { file: prepared, mimeType: "text/plain" }
      : undefined)
  }

  const mime = attachmentMime(file)
  if (typeof mime === "string") return { file, mimeType: mime }
  return mime?.then((mimeType) => mimeType ? { file, mimeType } : undefined)
}

export const prepareAttachmentFiles = (
  file: File,
  reservedFilenames: Iterable<string> = [],
): PreparedAttachmentFile[] | Promise<PreparedAttachmentFile[] | undefined> | undefined => {
  if (!DOCUMENT_EXTENSIONS.has(extensionOf(file.name))) {
    const prepared = prepareAttachmentFile(file)
    if (prepared instanceof Promise) return prepared.then((output) => output ? [output] : undefined)
    return prepared ? [prepared] : undefined
  }

  return import("./document-attachments").then(async ({ extractDocumentAttachments }) => {
    const extracted = await extractDocumentAttachments(file, reservedFilenames)
    if (!extracted) return
    const prepared: PreparedAttachmentFile[] = [{ file: extracted.textFile, mimeType: "text/plain" }]
    for (const image of extracted.images) {
      const output = await prepareAttachmentFile(image)
      if (!output || !output.mimeType.startsWith("image/")) return
      prepared.push(output)
    }
    return prepared
  })
}
