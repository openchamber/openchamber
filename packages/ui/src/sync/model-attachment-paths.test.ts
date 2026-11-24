import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { serverAttachmentSchema, toAttachedFile, withOriginalAttachment } from "@/stores/messageQueueAttachments"
import { attachmentWireName } from "@/lib/attachmentIdentity"
import { AttachmentPathSaveError, attachedFilesForModel, filesForModel } from "./model-attachment-paths"

const current = () => true

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

const model = { providerID: "provider", modelID: "selected" }
const withInputs = (input?: string[]) => {
  const original = useConfigStore.getState().getModelMetadata
  restores.push(() => useConfigStore.setState({ getModelMetadata: original }))
  useConfigStore.setState({
    getModelMetadata: () => ({ id: model.modelID, providerId: model.providerID, modalities: input ? { input } : undefined }),
  })
}
const mockWrite = (pathFor: (filename: string, index: number) => string = (filename) => `/tmp/opencode/openchamber/test/${filename}`) => {
  let index = 0
  const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => (
    files.map(({ filename }) => ({ filename, path: pathFor(filename, ++index) }))
  ))
  restores.push(() => write.mockRestore())
  return write
}
const NOTE_PREFIX = "data:text/plain;x-openchamber=path-note;base64,"
const noteText = (url: string): string => {
  expect(url.startsWith(NOTE_PREFIX)).toBe(true)
  return new TextDecoder().decode(Uint8Array.from(atob(url.slice(NOTE_PREFIX.length)), (char) => char.charCodeAt(0)))
}
const image = { type: "file" as const, mime: "image/jpeg", url: `data:image/jpeg;base64,${btoa("jpeg-bytes")}`, filename: "browser-annotation-1.jpg" }
const pdf = { type: "file" as const, mime: "application/pdf", url: `data:application/pdf;base64,${btoa("%PDF-1.4")}`, filename: "manual.pdf" }
const text = { type: "file" as const, mime: "text/plain", url: `data:text/plain;base64,${btoa("notes")}`, filename: "notes.txt" }

describe("attachments sent to a model without their input type", () => {
  test("a browser PDF is written to OpenCode and linked for a text-only model", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const [converted, untouched] = await filesForModel(model, [pdf, text], "/repo", current)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toBe("/repo")
    expect(write.mock.calls[0]?.[1][0]?.filename).toBe("manual.pdf")
    const source = write.mock.calls[0]?.[1][0]?.bytes
    const bytes = source instanceof Uint8Array ? source : await source?.()
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4")
    expect(converted.filename).toBe("manual.pdf")
    expect(converted.mime).toBe("text/plain")
    expect(noteText(converted.url)).toContain("[manual.pdf](/tmp/opencode/openchamber/test/manual.pdf)")
    expect(untouched).toBe(text)
  })

  test("a path note sent again to a model that lists no text input is not saved a second time", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const [note] = await filesForModel(model, [pdf], "/repo", current)
    withInputs([])
    const [resent] = await filesForModel(model, [note], "/repo", current)
    expect(resent).toBe(note)
    expect(write).toHaveBeenCalledTimes(1)
  })

  test("a reference an older build queued is recognized by its path and not saved again", async () => {
    withInputs([])
    const write = mockWrite()
    const queued = toAttachedFile(serverAttachmentSchema.parse({
      id: "a", filename: "plan.docx", mimeType: "text/plain", size: 10, source: "local",
      dataUrl: `data:text/plain;base64,${btoa("File on disk: /tmp/opencode/openchamber/abc/plan.docx")}`,
      agentPath: "/tmp/opencode/openchamber/abc/plan.docx", serverPath: "/tmp/opencode/openchamber/abc/plan.docx",
    }))
    expect(await attachedFilesForModel(model, [queued], "/repo", current)).toEqual([queued])
    const part = { mime: queued.mimeType, url: queued.dataUrl, filename: attachmentWireName(queued) }
    expect(await filesForModel(model, [part], "/repo", current)).toEqual([part])
    expect(noteText(queued.dataUrl)).toContain("/tmp/opencode/openchamber/abc/plan.docx")
    expect(write).not.toHaveBeenCalled()
  })

  test("a model that supports PDFs receives the PDF attachment unchanged", async () => {
    withInputs(["TEXT", "PDF"])
    const write = mockWrite()
    const [sent] = await filesForModel(model, [pdf], "/repo", current)
    expect(sent).toBe(pdf)
    expect(write).not.toHaveBeenCalled()
  })

  test("a model that reads images but not PDFs receives images normally", async () => {
    withInputs(["text", "image"])
    mockWrite()
    const [sentImage, sentPdf] = await filesForModel(model, [image, pdf], "/repo", current)
    expect(sentImage).toBe(image)
    expect(sentPdf.mime).toBe("text/plain")
    expect(noteText(sentPdf.url)).toContain("manual.pdf")
  })

  test("a text-only model gets an image path with the same attachment name", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const [convertedImage, untouched] = await filesForModel(model, [image, text], "/repo", current)
    expect(write).toHaveBeenCalledTimes(1)
    expect(convertedImage.filename).toBe("browser-annotation-1.jpg")
    expect(convertedImage.mime).toBe("text/plain")
    expect(noteText(convertedImage.url)).toContain("browser-annotation-1.jpg")
    expect(untouched).toBe(text)
  })

  test("a file already on OpenCode's filesystem uses its path without copying", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const [convertedPdf, convertedImage] = await filesForModel(model, [
      { ...text, url: "file:///repo/docs/manual%20v2.pdf", filename: "manual v2.pdf" },
      { ...text, url: "file:///repo/docs/diagram.png", filename: "diagram.png" },
    ], "/repo", current)
    expect(write).not.toHaveBeenCalled()
    expect(noteText(convertedPdf.url)).toContain("[manual v2.pdf](</repo/docs/manual v2.pdf>)")
    expect(noteText(convertedImage.url)).toContain("/repo/docs/diagram.png")
  })

  test("two attachments with the same name are saved to separate paths", async () => {
    withInputs(["text"])
    mockWrite((filename, index) => `/tmp/openchamber/${index}/${filename}`)
    const [first, second] = await filesForModel(model, [pdf, pdf], "/repo", current)
    expect(noteText(first.url)).toContain("/tmp/openchamber/1/manual.pdf")
    expect(noteText(second.url)).toContain("/tmp/openchamber/2/manual.pdf")
  })

  test("a failed PDF save blocks the entire send and preserves the file name", async () => {
    withInputs(["text"])
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => (
      files.map(({ filename }) => ({ filename, error: new Error("disk full") }))
    ))
    restores.push(() => write.mockRestore())

    const sending = filesForModel(model, [pdf, image, text], "/repo", current)
    await expect(sending).rejects.toBeInstanceOf(AttachmentPathSaveError)
    await expect(sending).rejects.toThrow("Could not save manual.pdf, browser-annotation-1.jpg")
  })

  test("unavailable model metadata preserves attachments without a speculative conversion", async () => {
    withInputs()
    const write = mockWrite()
    const [sent] = await filesForModel(model, [pdf], "/repo", current)
    expect(sent).toBe(pdf)
    expect(write).not.toHaveBeenCalled()
  })

  test("a queued PDF retains its identity and is saved before the queue takes it", async () => {
    withInputs(["text"])
    mockWrite()
    const file: AttachedFile = {
      id: "attachment-1", file: new File(["%PDF-1.4"], "manual.pdf", { type: "application/pdf" }),
      dataUrl: pdf.url, mimeType: pdf.mime, filename: pdf.filename, size: 8, source: "local",
    }
    const [converted] = await attachedFilesForModel(model, [file], "/repo", current)
    expect(converted.id).toBe(file.id)
    expect(converted.filename).toBe(file.filename)
    expect(converted.mimeType).toBe("text/plain")
    expect(noteText(converted.dataUrl)).toContain("/tmp/opencode/openchamber/test/manual.pdf")
    expect(converted.original).toEqual({ mimeType: "application/pdf", dataUrl: pdf.url })
    expect(file.mimeType).toBe("application/pdf")
  })

  test("a queued PDF edited back out has its own bytes, and a PDF model then receives the PDF", async () => {
    withInputs(["text"])
    mockWrite()
    const file: AttachedFile = {
      id: "attachment-1", file: new File(["%PDF-1.4"], "manual.pdf", { type: "application/pdf" }),
      dataUrl: pdf.url, mimeType: pdf.mime, filename: pdf.filename, size: 8, source: "local",
    }
    const [queued] = await attachedFilesForModel(model, [file], "/repo", current)
    const edited = withOriginalAttachment(queued)
    expect(edited.mimeType).toBe("application/pdf")
    expect(edited.dataUrl).toBe(pdf.url)
    expect(await edited.file.text()).toBe("%PDF-1.4")
    expect(edited.original).toBeUndefined()

    withInputs(["text", "pdf"])
    const [sent] = await filesForModel(model, [{ type: "file" as const, mime: edited.mimeType, url: edited.dataUrl, filename: edited.filename }], "/repo", current)
    expect(sent.mime).toBe("application/pdf")
    expect(sent.url).toBe(pdf.url)
  })

  test("a runtime switch before the save writes nothing and stops the send", async () => {
    withInputs(["text"])
    let switched = false
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, _files, options) => {
      switched = true
      if (options?.isCurrentRuntime && !options.isCurrentRuntime()) throw new Error("The file was not saved because the runtime changed.")
      throw new Error("unexpected write")
    })
    restores.push(() => write.mockRestore())
    const failure: unknown = await filesForModel(model, [pdf], "/repo", () => !switched).catch((error: unknown) => error)
    expect(failure instanceof Error && failure.message).toContain("runtime changed")
    expect(failure instanceof AttachmentPathSaveError).toBe(false)
  })

  test("links and folder references pass through untouched", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const issue = { ...text, mime: "application/vnd.github.issue-link", url: "https://github.com/o/r/issues/1", filename: "issue-1" }
    const folder = { ...text, mime: "application/x-directory", url: "file:///repo/src", filename: "src" }
    const [sentIssue, sentFolder] = await filesForModel(model, [issue, folder], "/repo", current)
    expect(sentIssue).toBe(issue)
    expect(sentFolder).toBe(folder)
    expect(write).not.toHaveBeenCalled()
  })

  test("an archive goes as a path even when the model's inputs are unknown", async () => {
    withInputs()
    mockWrite()
    const archive = { ...text, mime: "application/zip", url: `data:application/zip;base64,${btoa("PK\0\x01")}`, filename: "bundle.zip" }
    const [sent] = await filesForModel(model, [archive, pdf], "/repo", current)
    expect(noteText(sent.url)).toContain("bundle.zip")
  })

  test("unknown binary formats are saved even when the model lists other input formats", async () => {
    withInputs(["text", "image", "pdf"])
    const write = mockWrite()
    const archive = { ...text, mime: "application/zip", url: `data:application/zip;base64,${btoa("PK\0\x01")}`, filename: "bundle.zip" }
    const office = { ...text, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "report.docx" }
    const [sentArchive, sentOffice] = await filesForModel(model, [archive, office], "/repo", current)
    expect(write).toHaveBeenCalledTimes(2)
    expect(sentArchive.mime).toBe("text/plain")
    expect(noteText(sentArchive.url)).toContain("bundle.zip")
    expect(noteText(sentOffice.url)).toContain("report.docx")
  })

  test("audio and video without model support are saved as agent-readable paths", async () => {
    withInputs(["text", "pdf"])
    const write = mockWrite()
    const audio = { ...text, mime: "audio/mpeg", url: `data:audio/mpeg;base64,${btoa("ID3-test")}`, filename: "voice.mp3" }
    const video = { ...text, mime: "video/mp4", url: `data:video/mp4;base64,${btoa("mp4-test")}`, filename: "movie.mp4" }
    const [sentAudio, sentVideo] = await filesForModel(model, [audio, video], "/repo", current)
    expect(write).toHaveBeenCalledTimes(2)
    expect(sentAudio.mime).toBe("text/plain")
    expect(sentVideo.mime).toBe("text/plain")
    expect(noteText(sentAudio.url)).toContain("voice.mp3")
    expect(noteText(sentVideo.url)).toContain("movie.mp4")
  })

  test("a VS Code binary file URL uses its existing path without re-uploading", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const [sent] = await filesForModel(model, [
      { ...text, url: "file:///repo/docs/archive.zip", filename: "archive.zip" },
    ], "/repo", current)
    expect(write).not.toHaveBeenCalled()
    expect(sent.mime).toBe("text/plain")
    expect(noteText(sent.url)).toContain("/repo/docs/archive.zip")
  })

  test("media OpenCode does not hand to the model go as paths even when the model lists their input", async () => {
    withInputs(["text", "image", "audio", "video"])
    const write = mockWrite()
    const audio = { ...text, mime: "audio/mpeg", url: `data:audio/mpeg;base64,${btoa("ID3-test")}`, filename: "voice.mp3" }
    const video = { ...text, mime: "video/mp4", url: `data:video/mp4;base64,${btoa("mp4-test")}`, filename: "movie.mp4" }
    const avif = { ...text, mime: "image/avif", url: `data:image/avif;base64,${btoa("avif-test")}`, filename: "photo.avif" }
    const [sentAudio, sentVideo, sentAvif, sentImage] = await filesForModel(model, [audio, video, avif, image], "/repo", current)
    expect(write).toHaveBeenCalledTimes(3)
    expect(noteText(sentAudio.url)).toContain("voice.mp3")
    expect(noteText(sentVideo.url)).toContain("movie.mp4")
    expect(noteText(sentAvif.url)).toContain("photo.avif")
    expect(sentImage).toBe(image)
  })

  test("an absolute desktop path is reduced to a filename when copied", async () => {
    withInputs(["text"])
    const write = mockWrite()
    const [sent] = await filesForModel(model, [{ ...pdf, filename: "C:\\Users\\me\\manual.pdf" }], "/repo", current)
    expect(write.mock.calls[0]?.[1][0]?.filename).toBe("manual.pdf")
    expect(noteText(sent.url)).toContain("[manual.pdf]")
  })
})
