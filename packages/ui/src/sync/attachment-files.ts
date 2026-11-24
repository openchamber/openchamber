type OpenCodeAttachmentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/plain"

export type AttachmentInputModality = "text" | "image" | "pdf" | "audio" | "video"

export const PATH_NOTE_MEDIA_TYPE = "text/plain;x-openchamber=path-note"

export const isPathNoteDataUrl = (url: string): boolean => url.startsWith(`data:${PATH_NOTE_MEDIA_TYPE};`)

const REFERENCE_NOTE_OPENING = "File on disk: "
const SAVED_NOTE_OPENING = "File saved on disk: "
const PLAIN_TEXT_BASE64 = "data:text/plain;base64,"

export const fileReferenceNoteText = (path: string, size: string): string => (
  `${REFERENCE_NOTE_OPENING}${path} (${size}). Its content is not in this message. Read what you need from it with your tools.\n`
)

export const savedFileNoteText = (filename: string, path: string, detail: string): string => {
  const target = path.replace(/\\/g, "/")
  return `${SAVED_NOTE_OPENING}[${filename}](${/[\s()]/.test(target) ? `<${target}>` : target})\n${detail}\n`
}

export const withRestoredPathNoteMarker = (url: string): string => {
  if (!url.startsWith(PLAIN_TEXT_BASE64)) return url
  const payload = url.slice(PLAIN_TEXT_BASE64.length)
  let opening: string
  try {
    opening = atob(payload.slice(0, 28))
  } catch {
    return url
  }
  if (!opening.startsWith(REFERENCE_NOTE_OPENING) && !opening.startsWith(SAVED_NOTE_OPENING)) return url
  return `data:${PATH_NOTE_MEDIA_TYPE};base64,${payload}`
}

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
const IMAGE_MENTION_EXTENSIONS = new Set(["gif", "heic", "heif", "jpeg", "jpg", "png", "webp"])
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

export const isDocumentAttachmentFilename = (name: string): boolean => DOCUMENT_EXTENSIONS.has(extensionOf(name))

export const isReadOnSendMentionFilename = (name: string): boolean => {
  const extension = extensionOf(name)
  return DOCUMENT_EXTENSIONS.has(extension) || IMAGE_MENTION_EXTENSIONS.has(extension)
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

export class HeicConversionError extends Error {
  constructor(file: File) {
    super(`Could not convert ${file.name} from HEIC to JPEG`)
    this.name = "HeicConversionError"
  }
}

const convertHeicToJpeg = async (file: File): Promise<File> => {
  try {
    const heic2any = (await import("heic2any")).default
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 })
    const blob = Array.isArray(converted) ? converted[0] : converted
    if (!blob) throw new Error("the decoder returned no image")
    const filename = file.name.replace(/\.(heic|heif)$/i, ".jpg")
    return new File([blob], filename, { type: "image/jpeg" })
  } catch (error) {
    console.warn("Failed to convert HEIC attachment to JPEG", error)
    throw new HeicConversionError(file)
  }
}

export const prepareAttachmentFile = (
  file: File,
): PreparedAttachmentFile | Promise<PreparedAttachmentFile | undefined> | undefined => {
  const extension = extensionOf(file.name)
  const type = declaredMimeOf(file)
  if (type === "image/heic" || type === "image/heif" || extension === "heic" || extension === "heif") {
    return convertHeicToJpeg(file).then((converted) => ({ file: converted, mimeType: "image/jpeg" }))
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
  if (!isDocumentAttachmentFilename(file.name)) {
    const prepared = prepareAttachmentFile(file)
    if (prepared instanceof Promise) return prepared.then((output) => output ? [output] : undefined)
    return prepared ? [prepared] : undefined
  }

  return import("./document-attachments").then(async ({ extractDocumentAttachments }) => {
    const extracted = await extractDocumentAttachments(file, reservedFilenames)
    if (!extracted) return
    const prepared: PreparedAttachmentFile[] = [{ file: extracted.textFile, mimeType: "text/plain" }]
    for (const image of extracted.images) {
      let output: PreparedAttachmentFile | undefined
      try {
        output = await prepareAttachmentFile(image)
      } catch (error) {
        if (!(error instanceof HeicConversionError)) throw error
      }
      if (!output || !output.mimeType.startsWith("image/")) return
      prepared.push(output)
    }
    return prepared
  })
}
