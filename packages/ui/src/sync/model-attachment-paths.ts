import { attachmentBasename, attachmentWireName } from "@/lib/attachmentIdentity"
import { opencodeClient } from "@/lib/opencode/client"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { useConfigStore } from "@/stores/useConfigStore"
import { getAttachmentInputModality, isPathNoteDataUrl, PATH_NOTE_MEDIA_TYPE, savedFileNoteText, type AttachmentInputModality } from "./attachment-files"

type FilePart = { mime: string; url: string; filename: string }

export class AttachmentPathSaveError extends Error {
  readonly filenames: string[]

  constructor(filenames: string[]) {
    super(`Could not save ${filenames.join(", ")} for a model that cannot read these attachments`)
    this.name = "AttachmentPathSaveError"
    this.filenames = filenames
  }
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?)$/i
const AUDIO_EXTENSION = /\.(aac|flac|m4a|mp3|ogg|opus|wav|wma)$/i
const VIDEO_EXTENSION = /\.(avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/i
const BINARY_EXTENSION = /\.(7z|bin|docx?|epub|gz|odp|ods|odt|pptx?|rar|tar|xls[xm]?|zip)$/i

const inputModality = (file: FilePart): AttachmentInputModality | undefined => {
  if (file.url.startsWith("file:")) {
    if (IMAGE_EXTENSION.test(file.filename)) return "image"
    if (/\.pdf$/i.test(file.filename)) return "pdf"
    if (AUDIO_EXTENSION.test(file.filename)) return "audio"
    if (VIDEO_EXTENSION.test(file.filename)) return "video"
    if (BINARY_EXTENSION.test(file.filename)) return undefined
  }
  return getAttachmentInputModality(file.mime)
}

const DELIVERABLE_MEDIA_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])
const DELIVERABLE_MEDIA_EXTENSION = /\.(png|jpe?g|gif|webp|pdf)$/i

const isDeliverableMedia = (file: FilePart): boolean => (
  file.url.startsWith("file:")
    ? DELIVERABLE_MEDIA_EXTENSION.test(file.filename)
    : DELIVERABLE_MEDIA_MIME.has(file.mime.split(";", 1)[0].trim().toLowerCase())
)

const isUnreadableBinary = (file: FilePart): boolean => (
  file.url.startsWith("data:") || (file.url.startsWith("file:") && BINARY_EXTENSION.test(file.filename))
)

const needsPath = (file: FilePart, supported: Set<string> | null): boolean => {
  if (isPathNoteDataUrl(file.url)) return false
  const modality = inputModality(file)
  if (!modality) return isUnreadableBinary(file)
  if (modality !== "text" && !isDeliverableMedia(file)) return true
  return supported !== null && !supported.has(modality)
}

const decodeDataUrl = (url: string): Uint8Array | null => {
  const comma = url.indexOf(",")
  if (!url.startsWith("data:") || comma < 0) return null
  const payload = url.slice(comma + 1)
  try {
    if (!url.slice(0, comma).toLowerCase().endsWith(";base64")) return new TextEncoder().encode(decodeURIComponent(payload))
    return Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

const fileUrlPath = (url: string): string | null => {
  if (!url.startsWith("file:")) return null
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

const pathNoteUrl = (file: FilePart, path: string): string => {
  const text = savedFileNoteText(
    attachmentBasename(file.filename),
    path,
    "The model cannot read this attachment directly. Open the file with your tools if you need it.",
  )
  return `data:${PATH_NOTE_MEDIA_TYPE};base64,${btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""))}`
}

const savedPath = async (
  file: FilePart,
  directory: string | null | undefined,
  isCurrentRuntime: () => boolean,
): Promise<string | null> => {
  const onDisk = fileUrlPath(file.url)
  if (onDisk) return onDisk
  const bytes = decodeDataUrl(file.url)
  if (!bytes) return null
  const results = await opencodeClient.writeOpenCodeTempFiles(
    directory,
    [{ filename: attachmentBasename(file.filename), bytes }],
    { isCurrentRuntime },
  ).catch((error: unknown) => {
    if (!isCurrentRuntime()) throw error
    return []
  })
  const [result] = results
  return result && "path" in result ? result.path : null
}

export const filesForModel = async <T extends FilePart>(
  model: { providerID: string; modelID: string },
  files: T[],
  directory: string | null | undefined,
  isCurrentRuntime: () => boolean,
): Promise<T[]> => {
  const input = useConfigStore.getState().getModelMetadata(model.providerID, model.modelID)?.modalities?.input
  const supported = input ? new Set(input.map((modality) => modality.toLowerCase())) : null
  const paths = await Promise.all(files.map((file) => (
    needsPath(file, supported) ? savedPath(file, directory, isCurrentRuntime) : Promise.resolve(undefined)
  )))
  const failed = files.flatMap((file, index) => (paths[index] === null ? [attachmentBasename(file.filename)] : []))
  if (failed.length > 0) throw new AttachmentPathSaveError(failed)
  return files.map((file, index) => {
    const path = paths[index]
    return path ? { ...file, mime: "text/plain", url: pathNoteUrl(file, path) } : file
  })
}

export const attachedFilesForModel = async (
  model: { providerID: string; modelID: string },
  files: AttachedFile[],
  directory: string | null | undefined,
  isCurrentRuntime: () => boolean,
): Promise<AttachedFile[]> => {
  const parts = files.map((file) => ({ mime: file.mimeType, url: file.dataUrl, filename: attachmentWireName(file) }))
  const converted = await filesForModel(model, parts, directory, isCurrentRuntime)
  return files.map((file, index) => (
    converted[index] === parts[index] ? file : {
      ...file,
      mimeType: converted[index].mime,
      dataUrl: converted[index].url,
      original: { mimeType: file.mimeType, dataUrl: file.dataUrl },
    }
  ))
}
