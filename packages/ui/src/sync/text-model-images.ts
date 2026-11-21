import { attachmentWireName } from "@/lib/attachmentIdentity"
import { opencodeClient } from "@/lib/opencode/client"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { useConfigStore } from "@/stores/useConfigStore"
import { getAttachmentInputModality, getUnsupportedAttachmentInputs } from "./attachment-files"

type FilePart = { mime: string; url: string; filename: string }

export class ImageSaveForTextModelError extends Error {
  readonly filenames: string[]

  constructor(filenames: string[]) {
    super(`Could not save ${filenames.join(", ")} for a model that cannot read images`)
    this.name = "ImageSaveForTextModelError"
    this.filenames = filenames
  }
}

export const modelCannotReadImages = (providerID: string | null | undefined, modelID: string | null | undefined): boolean => {
  if (!providerID || !modelID) return false
  const input = useConfigStore.getState().getModelMetadata(providerID, modelID)?.modalities?.input
  return Boolean(input && getUnsupportedAttachmentInputs([{ mimeType: "image/png" }], input).length > 0)
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?)$/i

const isImageFile = (file: FilePart): boolean => (
  getAttachmentInputModality(file.mime) === "image" || (file.url.startsWith("file:") && IMAGE_EXTENSION.test(file.filename))
)

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

const pathNoteUrl = (path: string): string => {
  const text = `Image on disk: ${path}. The model can't read images, so only this path is in the message. Open the file with your tools if you need it.\n`
  return `data:text/plain;base64,${btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""))}`
}

const savedPath = async (file: FilePart, directory: string | null | undefined): Promise<string | null> => {
  const onDisk = fileUrlPath(file.url)
  if (onDisk) return onDisk
  const bytes = decodeDataUrl(file.url)
  if (!bytes) return null
  const [result] = await opencodeClient.writeOpenCodeTempFiles(directory, [{ filename: file.filename, bytes }]).catch(() => [])
  return result && "path" in result ? result.path : null
}

export async function imagesAsPathNotes<T extends FilePart>(files: T[], directory: string | null | undefined): Promise<T[]> {
  const paths = await Promise.all(files.map((file) => (isImageFile(file) ? savedPath(file, directory) : Promise.resolve(undefined))))
  const failed = files.flatMap((file, index) => (paths[index] === null ? [file.filename] : []))
  if (failed.length > 0) throw new ImageSaveForTextModelError(failed)
  return files.map((file, index) => {
    const path = paths[index]
    return path ? { ...file, mime: "text/plain", url: pathNoteUrl(path) } : file
  })
}

export const filesForModel = <T extends FilePart>(
  model: { providerID: string; modelID: string },
  files: T[],
  directory: string | null | undefined,
): Promise<T[]> => (modelCannotReadImages(model.providerID, model.modelID) ? imagesAsPathNotes(files, directory) : Promise.resolve(files))

export async function attachedImagesAsPathNotes(files: AttachedFile[], directory: string | null | undefined): Promise<AttachedFile[]> {
  const parts = files.map((file) => ({ mime: file.mimeType, url: file.dataUrl, filename: attachmentWireName(file) }))
  const converted = await imagesAsPathNotes(parts, directory)
  return files.map((file, index) => (
    converted[index] === parts[index] ? file : { ...file, mimeType: converted[index].mime, dataUrl: converted[index].url }
  ))
}
