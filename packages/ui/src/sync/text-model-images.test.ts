import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { ImageSaveForTextModelError, imagesAsPathNotes, modelCannotReadImages } from "./text-model-images"

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

const noteText = (url: string): string => {
  expect(url.startsWith("data:text/plain;base64,")).toBe(true)
  return new TextDecoder().decode(Uint8Array.from(atob(url.slice("data:text/plain;base64,".length)), (char) => char.charCodeAt(0)))
}

const image = { type: "file" as const, mime: "image/jpeg", url: `data:image/jpeg;base64,${btoa("jpeg-bytes")}`, filename: "browser-annotation-1.jpg" }
const text = { type: "file" as const, mime: "text/plain", url: `data:text/plain;base64,${btoa("notes")}`, filename: "notes.txt" }

describe("images for a model that cannot read them", () => {
  test("an image becomes a note naming the file OpenCode saved, under the same name", async () => {
    const written: Array<{ filename: string; bytes: string }> = []
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => {
      written.push(...files.map(({ filename, bytes }) => ({ filename, bytes: new TextDecoder().decode(bytes) })))
      return files.map(({ filename }) => ({ filename, path: `/tmp/opencode/openchamber/abc/${filename}` }))
    })
    restores.push(() => write.mockRestore())

    const [convertedImage, untouched] = await imagesAsPathNotes([image, text], "/repo")

    expect(written).toEqual([{ filename: "browser-annotation-1.jpg", bytes: "jpeg-bytes" }])
    expect(untouched).toBe(text)
    expect(convertedImage.filename).toBe("browser-annotation-1.jpg")
    expect(convertedImage.mime).toBe("text/plain")
    expect(noteText(convertedImage.url)).toContain("/tmp/opencode/openchamber/abc/browser-annotation-1.jpg")
  })

  test("an image already on disk names its own path without a copy", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles")
    restores.push(() => write.mockRestore())

    const [converted] = await imagesAsPathNotes([{ ...image, url: "file:///Users/me/shots/a%20b.png", mime: "image/png" }], "/repo")

    expect(write).not.toHaveBeenCalled()
    expect(noteText(converted.url)).toContain("/Users/me/shots/a b.png")
  })

  test("an image file VS Code attached by path counts as an image", async () => {
    const [converted] = await imagesAsPathNotes([{ ...text, url: "file:///repo/docs/diagram.png", filename: "diagram.png" }], "/repo")

    expect(noteText(converted.url)).toContain("/repo/docs/diagram.png")
  })

  test("two images under one name land in separate files", async () => {
    let folder = 0
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => {
      folder += 1
      return files.map(({ filename }) => ({ filename, path: `/tmp/openchamber/${folder}/${filename}` }))
    })
    restores.push(() => write.mockRestore())

    const [first, second] = await imagesAsPathNotes([image, { ...image, url: `data:image/jpeg;base64,${btoa("other")}` }], "/repo")

    expect(noteText(first.url)).toContain("/tmp/openchamber/1/browser-annotation-1.jpg")
    expect(noteText(second.url)).toContain("/tmp/openchamber/2/browser-annotation-1.jpg")
  })

  test("an image that could not be saved fails the send and names the file", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => (
      files.map(({ filename }) => ({ filename, error: new Error("disk full") }))
    ))
    restores.push(() => write.mockRestore())

    const sending = imagesAsPathNotes([image, text], "/repo")

    await expect(sending).rejects.toBeInstanceOf(ImageSaveForTextModelError)
    await expect(sending).rejects.toThrow("Could not save browser-annotation-1.jpg for a model")
  })

  test("only a model that lists its inputs without images counts as text-only", () => {
    const original = useConfigStore.getState().getModelMetadata
    restores.push(() => useConfigStore.setState({ getModelMetadata: original }))
    const inputs = new Map([["text", ["text"]], ["vision", ["text", "image"]]])
    useConfigStore.setState({
      getModelMetadata: (providerId, modelId) => {
        const input = inputs.get(modelId)
        return { id: modelId, providerId, modalities: input ? { input } : undefined }
      },
    })

    expect(modelCannotReadImages("provider", "text")).toBe(true)
    expect(modelCannotReadImages("provider", "vision")).toBe(false)
    expect(modelCannotReadImages("provider", "unknown")).toBe(false)
    expect(modelCannotReadImages(null, "text")).toBe(false)
  })
})
