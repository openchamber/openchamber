import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { useInputStore } from "./input-store"
import { getChatDraftIdentityKey } from "@/lib/chatDraftPersistence"
import { opencodeClient } from "@/lib/opencode/client"
import { attachmentWireName } from "@/lib/attachmentIdentity"
import { useConfigStore } from "@/stores/useConfigStore"
import { serverAttachmentSchema, toAttachedFile, toServerAttachment, withOriginalAttachment } from "@/stores/messageQueueAttachments"
import { attachedFilesForModel, filesForModel } from "./model-attachment-paths"
import { fileReferenceNoteText, savedFileNoteText } from "./attachment-files"
import { saveAttachmentsHeldForSend as saveHeldForSend } from "@/components/chat/composer/input/saveAttachmentsHeldForSend"

// A HEIC conversion that fails the way the vendored decoder does for Apple's
// HDR gain-map photos.
const decodeHeic = async (): Promise<Blob> => {
  throw new Error("ERR_LIBHEIF format not supported")
}

mock.module("heic2any", () => ({
  default: async () => decodeHeic(),
}))

class MockFileReader {
  result: string | ArrayBuffer | null = null
  onload: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null
  onerror: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null
  onabort: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null
  error: DOMException | null = null

  readAsDataURL() {
    pendingReaders.push(this)
  }
}

const pendingReaders: MockFileReader[] = []
const originalFileReader = globalThis.FileReader

const restoreFileReader = () => {
  pendingReaders.length = 0
  globalThis.FileReader = originalFileReader
}

const testWithMockFileReader = (name: string, fn: () => Promise<void>) => {
  test(name, async () => {
    try {
      await fn()
    } finally {
      restoreFileReader()
    }
  })
}

const resolveReader = (reader: MockFileReader, result: string) => {
  reader.result = result
  reader.onload?.call(reader as unknown as FileReader, {} as ProgressEvent<FileReader>)
}

const rejectReader = (reader: MockFileReader) => {
  reader.error = new DOMException("read failed", "NotReadableError")
  reader.onerror?.call(reader as unknown as FileReader, {} as ProgressEvent<FileReader>)
}

const waitForReaderCount = async (count: number) => {
  for (let attempt = 0; attempt < 100 && pendingReaders.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

describe("input-store composer restore", () => {
  beforeEach(() => {
    useInputStore.setState({ pendingComposerRestore: null })
  })

  test("only the destination can consume a restore, and only once", () => {
    const target = { runtimeKey: "runtime", directory: "/repo", sessionId: "fork" }
    const pending = { target, text: "replay", files: [] }
    useInputStore.setState({ pendingComposerRestore: pending })
    for (const identity of [
      null,
      { ...target, sessionId: "source" },
      { ...target, directory: "/elsewhere" },
      { ...target, runtimeKey: "other-runtime" },
    ]) {
      expect(useInputStore.getState().consumePendingComposerRestore(identity)).toBeNull()
      expect(useInputStore.getState().pendingComposerRestore).toBe(pending)
    }
    expect(useInputStore.getState().consumePendingComposerRestore(target)).toBe(pending)
    expect(useInputStore.getState().consumePendingComposerRestore(target)).toBeNull()
  })

  test("keeps ordinary pending text independent from fork restoration", () => {
    const target = { runtimeKey: "runtime", directory: "/repo", sessionId: "fork" }
    const pending = { target, text: "", files: [] }
    useInputStore.setState({ pendingComposerRestore: pending })
    useInputStore.getState().setPendingInputText("ordinary insertion", "append")
    expect(useInputStore.getState().consumePendingInputText()).toEqual({ text: "ordinary insertion", mode: "append" })
    expect(useInputStore.getState().consumePendingComposerRestore(target)).toBe(pending)
  })
})

describe("input-store attachments", () => {
  beforeEach(() => {
    pendingReaders.length = 0
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader
    useInputStore.setState({
      pendingInputText: null,
      pendingInputMode: "replace",
      pendingSyntheticParts: null,
      pendingGuestIssue: null,
      pendingBtwComposerRequest: null,
      activeEditorFile: null,
      attachmentDraftKey: null,
      attachmentDrafts: new Map(),
    })
    useInputStore.getState().setAttachedFiles([])
  })

  testWithMockFileReader("a file restored while another is being read keeps both", async () => {
    const pasting = useInputStore.getState().addAttachedFile(new File([pngBytes], "pasted.png", { type: "image/png" }))
    await waitForReaderCount(1)

    const restored = { id: "restored-1", file: new File([pngBytes], "shot.jpg", { type: "image/jpeg" }), dataUrl: "data:image/jpeg;base64,AA==", mimeType: "image/jpeg", filename: "shot.jpg", size: pngBytes.length, source: "local" as const }
    useInputStore.getState().restoreAttachedFiles([restored], null)
    resolveReader(pendingReaders[0]!, "data:image/png;base64,iVBORw0KGgo=")

    expect(await pasting).toBe(true)
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename).sort()).toEqual(["pasted.png", "shot.jpg"])
  })

  testWithMockFileReader("refuses a file over 10 MB without reading it when it has no path on disk", async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "place.rbxl")

    await expect(useInputStore.getState().addAttachedFile(big)).rejects.toThrow("place.rbxl")

    expect(pendingReaders).toHaveLength(0)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("refuses a file over 20 MB without suggesting an @-mention, which OpenCode would refuse too", async () => {
    const huge = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "map.png", { type: "image/png" })

    let message = ""
    try {
      await useInputStore.getState().addAttachedFile(huge)
    } catch (error) {
      message = error instanceof Error ? error.message : ""
    }

    expect(message.includes("map.png")).toBe(true)
    expect(message.includes("@")).toBe(false)
    expect(pendingReaders).toHaveLength(0)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("refuses a file held for Send over 20 MB by name without reading it", async () => {
    const huge = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "deck.pptx")

    await expect(useInputStore.getState().addAttachedFile(huge, undefined, undefined, { saveOnSend: "reference" })).rejects.toThrow("deck.pptx")

    expect(pendingReaders).toHaveLength(0)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("holds a HEIC the decoder cannot read until Send, writes it once there and Edit gets the photo back", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => (
      files.map(({ filename }) => ({ filename, path: `/tmp/opencode/openchamber/abc/${filename}` }))
    ))
    try {
      const adding = useInputStore.getState().addAttachedFile(new File(["heic-data"], "IMG_4015.heic", { type: "image/heic" }))
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:image/heic;base64,aGVpYy1kYXRh")
      expect(await adding).toBe(true)

      expect(write).not.toHaveBeenCalled()
      const [held] = useInputStore.getState().attachedFiles
      expect(held?.saveOnSend).toBe(true)
      expect(held?.mimeType).toBe("image/heic")
      expect(held?.filename).toBe("IMG_4015.heic")

      const saving = useInputStore.getState().saveAttachmentsHeldForSend(null, "/repo", new Set(useInputStore.getState().attachedFiles.map((file) => file.id)))
      await waitForReaderCount(2)
      resolveReader(pendingReaders[1], "data:text/plain;base64,bm90ZQ==")
      expect(await saving).toEqual([])

      // The original bytes, unconverted, under the original name, written once.
      expect(write).toHaveBeenCalledTimes(1)
      const [, files] = write.mock.calls[0]
      expect(files.map(({ filename }) => filename)).toEqual(["IMG_4015.heic"])
      const bytes = files[0].bytes
      expect(new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : await bytes())).toBe("heic-data")
      const [reference] = useInputStore.getState().attachedFiles
      expect(reference?.mimeType).toBe("text/plain")
      expect(reference?.agentPath).toBe("/tmp/opencode/openchamber/abc/IMG_4015.heic")
      expect(await reference?.file?.text()).toContain("/tmp/opencode/openchamber/abc/IMG_4015.heic")

      const queued = toAttachedFile(serverAttachmentSchema.parse(JSON.parse(JSON.stringify(toServerAttachment(reference!)))))
      const edited = withOriginalAttachment(queued)
      expect(edited.saveOnSend).toBe(true)
      expect(edited.mimeType).toBe("image/heic")
      expect(edited.dataUrl).toBe(held?.dataUrl)
      expect(edited.agentPath).toBeUndefined()
    } finally {
      write.mockRestore()
    }
  })

  testWithMockFileReader("holds a shared HEIC the decoder cannot read the same way, without writing it anywhere", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles")
    const share = { runtimeKey: "runtime", directory: "/repo", sessionId: "draft:share" }
    try {
      useInputStore.getState().selectAttachmentDraft(share)
      const adding = useInputStore.getState().addAttachedFile(new File(["heic-data"], "IMG_4015.heic", { type: "image/heic" }), share, undefined, { shared: true })
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:image/heic;base64,aGVpYy1kYXRh")
      expect(await adding).toBe(true)

      expect(write).not.toHaveBeenCalled()
      expect(useInputStore.getState().attachedFiles.map((file) => [file.filename, file.saveOnSend])).toEqual([["IMG_4015.heic", true]])
    } finally {
      write.mockRestore()
    }
  })

  testWithMockFileReader("an image saved as a file goes with a path note to its copy, written only at Send", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => (
      files.map(({ filename }) => ({ filename, path: `/tmp/opencode/openchamber/abc/${filename}` }))
    ))
    try {
      const adding = useInputStore.getState().addAttachedFile(new File([pngBytes], "image-1.png", { type: "image/png" }), undefined, undefined, { saveOnSend: "copy" })
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:image/png;base64,iVBORw0KGgo=")
      expect(await adding).toBe(true)

      expect(write).not.toHaveBeenCalled()
      const [held] = useInputStore.getState().attachedFiles
      expect(held?.saveCopyOnSend).toBe(true)
      expect(held?.mimeType).toBe("image/png")

      // Send and Queue go through the composer's step, which must see a draft holding only a copy.
      const saving = saveHeldForSend(null, "/repo", useInputStore.getState().attachedFiles, (key) => key)
      await waitForReaderCount(2)
      resolveReader(pendingReaders[1], "data:text/plain;base64,bm90ZQ==")
      expect(await saving).toBe("saved")

      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][2]?.isCurrentRuntime?.()).toBe(true)
      const [image, note] = useInputStore.getState().attachedFiles
      expect(image?.id).toBe(held?.id)
      expect(image?.saveCopyOnSend).toBeUndefined()
      expect(image?.dataUrl).toBe(held?.dataUrl)
      expect(note?.filename).toBe("image-1.png")
      expect(note?.agentPath).toBe("/tmp/opencode/openchamber/abc/image-1.png")
      expect(note?.dataUrl.startsWith("data:text/plain;x-openchamber=path-note;base64,")).toBe(true)
      expect(await note?.file.text()).toContain("[image-1.png](/tmp/opencode/openchamber/abc/image-1.png)")

      // Queued and taken back by Edit: the image and the note to its copy, so a resend writes nothing again.
      const edited = useInputStore.getState().attachedFiles.map((file) => (
        withOriginalAttachment(toAttachedFile(serverAttachmentSchema.parse(JSON.parse(JSON.stringify(toServerAttachment(file))))))
      ))
      expect(edited.map((file) => [file.mimeType, file.dataUrl])).toEqual([[image!.mimeType, image!.dataUrl], [note!.mimeType, note!.dataUrl]])
      const getModelMetadata = useConfigStore.getState().getModelMetadata
      useConfigStore.setState({ getModelMetadata: () => ({ id: "m", providerId: "p", modalities: { input: ["image"] } }) })
      try {
        expect(await attachedFilesForModel({ providerID: "p", modelID: "m" }, edited, "/repo", () => true)).toEqual(edited)
      } finally {
        useConfigStore.setState({ getModelMetadata })
      }
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      write.mockRestore()
    }
  })

  testWithMockFileReader("Send writes only the held files the message cites, once even when Send is pressed twice", async () => {
    let finishWrite = () => {}
    let writeStarted = () => {}
    const started = new Promise<void>((resolve) => { writeStarted = resolve })
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => {
      writeStarted()
      await new Promise<void>((resolve) => { finishWrite = resolve })
      return files.map(({ filename }) => ({ filename, path: `/tmp/opencode/openchamber/abc/${filename}` }))
    })
    try {
      const input = useInputStore.getState()
      for (const name of ["cited.docx", "removed.docx"]) {
        const adding = input.addAttachedFile(new File(["docx"], name), undefined, undefined, { saveOnSend: "reference" })
        await waitForReaderCount(1)
        resolveReader(pendingReaders.shift()!, "data:application/octet-stream;base64,ZG9jeA==")
        await adding
      }
      const [cited] = useInputStore.getState().attachedFiles
      const sent = new Set([cited!.id])

      const first = input.saveAttachmentsHeldForSend(null, "/repo", sent)
      const second = input.saveAttachmentsHeldForSend(null, "/repo", sent)
      await started
      finishWrite()
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:text/plain;base64,bm90ZQ==")
      expect(await first).toEqual([])
      expect(await second).toEqual([])

      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][1].map(({ filename }) => filename)).toEqual(["cited.docx"])
      expect(useInputStore.getState().attachedFiles.map((file) => [file.filename, Boolean(file.saveOnSend)])).toEqual([
        ["cited.docx", false],
        ["removed.docx", true],
      ])
    } finally {
      write.mockRestore()
    }
  })

  testWithMockFileReader("an image over 10 MB saved as a file is held to go as its path, instead of refused", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles")
    try {
      const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "scan.png", { type: "image/png" })
      const adding = useInputStore.getState().addAttachedFile(big, undefined, undefined, { saveOnSend: "copy" })
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:image/png;base64,AAAA")
      expect(await adding).toBe(true)
      const [held] = useInputStore.getState().attachedFiles
      expect(held?.saveOnSend).toBe(true)
      expect(held?.saveCopyOnSend).toBeUndefined()
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  test("a path note restored from a sent message is still a path note, so a resend writes nothing", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles")
    const getModelMetadata = useConfigStore.getState().getModelMetadata
    useConfigStore.setState({ getModelMetadata: () => ({ id: "m", providerId: "p", modalities: { input: [] } }) })
    try {
      // OpenCode hands sent file parts back as plain text, without the note's media type parameter.
      const path = "/tmp/opencode/openchamber/abc/plan.docx"
      const input = useInputStore.getState()
      input.addRestoredAttachment({ url: `data:text/plain;base64,${btoa(fileReferenceNoteText(path, "10 B"))}`, mimeType: "text/plain", filename: path })
      input.addRestoredAttachment({ url: `data:text/plain;base64,${btoa(savedFileNoteText("photo.png", "/tmp/opencode/openchamber/def/photo.png", "The model cannot read this attachment directly."))}`, mimeType: "text/plain", filename: "photo.png" })
      input.addRestoredAttachment({ url: "data:text/plain;base64,aGVsbG8=", mimeType: "text/plain", filename: "hello.txt" })

      const [reference, converted, plain] = useInputStore.getState().attachedFiles
      expect(reference?.dataUrl.startsWith("data:text/plain;x-openchamber=path-note;base64,")).toBe(true)
      expect(converted?.dataUrl.startsWith("data:text/plain;x-openchamber=path-note;base64,")).toBe(true)
      expect(plain?.dataUrl).toBe("data:text/plain;base64,aGVsbG8=")

      const notes = [reference!, converted!]
      expect(await attachedFilesForModel({ providerID: "p", modelID: "m" }, notes, "/repo", () => true)).toEqual(notes)
      expect(write).not.toHaveBeenCalled()
    } finally {
      useConfigStore.setState({ getModelMetadata })
      write.mockRestore()
    }
  })

  testWithMockFileReader("a shared file read across a draft switch lands in the share's draft, not the one on screen", async () => {
    const share = { runtimeKey: "runtime", directory: "/repo", sessionId: "draft:share" }
    const other = { runtimeKey: "runtime", directory: "/repo", sessionId: "other" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(share)
    const adding = input.addAttachedFile(new File(["hello"], "notes.txt", { type: "text/plain" }), share, undefined, { shared: true })
    await waitForReaderCount(1)

    input.selectAttachmentDraft(other)
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")

    expect(await adding).toBe(true)
    expect(useInputStore.getState().attachedFiles).toEqual([])
    expect(useInputStore.getState().getAttachedFiles(share).map((file) => file.filename)).toEqual(["notes.txt"])
  })

  testWithMockFileReader("an original kept for Send is written only when the send asks, then becomes a reference", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async (_directory, files) => (
      files.map(({ filename }) => ({ filename, path: `/tmp/opencode/openchamber/abc/${filename}` }))
    ))
    const share = { runtimeKey: "runtime", directory: "/repo", sessionId: "draft:share" }
    try {
      const input = useInputStore.getState()
      input.selectAttachmentDraft(share)
      const adding = input.addAttachedFile(new File(["docx-bytes"], "plan.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), share, undefined, { shared: true, saveOnSend: "reference" })
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:application/octet-stream;base64,ZG9jeA==")
      await adding

      expect(write).not.toHaveBeenCalled()
      const [held] = useInputStore.getState().attachedFiles
      expect(held?.saveOnSend).toBe(true)
      expect(held?.filename).toBe("plan.docx")

      const saving = useInputStore.getState().saveAttachmentsHeldForSend(share, "/repo", new Set(useInputStore.getState().attachedFiles.map((file) => file.id)))
      await waitForReaderCount(2)
      resolveReader(pendingReaders[1], "data:text/plain;base64,bm90ZQ==")
      expect(await saving).toEqual([])

      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][0]).toBe("/repo")
      // The write is bound to the runtime the send started on.
      expect(write.mock.calls[0][2]?.isCurrentRuntime?.()).toBe(true)
      const [reference] = useInputStore.getState().attachedFiles
      expect(reference?.id).toBe(held?.id)
      expect(reference?.saveOnSend).toBeUndefined()
      expect(reference?.mimeType).toBe("text/plain")
      expect(reference?.agentPath).toBe("/tmp/opencode/openchamber/abc/plan.docx")

      // Send and Queue hand the reference to a model that lists no text input: it is already a path.
      const getModelMetadata = useConfigStore.getState().getModelMetadata
      useConfigStore.setState({ getModelMetadata: () => ({ id: "m", providerId: "p", modalities: { input: [] } }) })
      try {
        const model = { providerID: "p", modelID: "m" }
        const part = { mime: reference!.mimeType, url: reference!.dataUrl, filename: attachmentWireName(reference!) }
        expect(await filesForModel(model, [part], "/repo", () => true)).toEqual([part])
        expect(await attachedFilesForModel(model, [reference!], "/repo", () => true)).toEqual([reference!])
      } finally {
        useConfigStore.setState({ getModelMetadata })
      }
      expect(write).toHaveBeenCalledTimes(1)

      // The queue delivers the reference and keeps the document; Edit puts it back held for Send.
      const queued = toAttachedFile(serverAttachmentSchema.parse(JSON.parse(JSON.stringify(toServerAttachment(reference!)))))
      expect(queued.dataUrl).toBe(reference?.dataUrl)
      const edited = withOriginalAttachment(queued)
      expect(edited.saveOnSend).toBe(true)
      expect(edited.mimeType).toBe(held?.mimeType)
      expect(edited.dataUrl).toBe(held?.dataUrl)
      expect(edited.agentPath).toBeUndefined()
      expect(edited.serverPath).toBeUndefined()
      expect(edited.original).toBeUndefined()
      expect(await edited.file.text()).toBe("docx")
    } finally {
      write.mockRestore()
    }
  })

  testWithMockFileReader("an original that cannot be written at Send stays held and is named", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles").mockImplementation(async () => {
      throw new Error("OpenCode is not reachable")
    })
    const share = { runtimeKey: "runtime", directory: "/repo", sessionId: "draft:share" }
    try {
      const input = useInputStore.getState()
      input.selectAttachmentDraft(share)
      const adding = input.addAttachedFile(new File(["docx-bytes"], "plan.docx"), share, undefined, { shared: true, saveOnSend: "reference" })
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:application/octet-stream;base64,ZG9jeA==")
      await adding

      expect(await useInputStore.getState().saveAttachmentsHeldForSend(share, "/repo", new Set(useInputStore.getState().attachedFiles.map((file) => file.id)))).toEqual(["plan.docx"])
      expect(useInputStore.getState().attachedFiles[0]?.saveOnSend).toBe(true)
    } finally {
      write.mockRestore()
    }
  })

  test("refuses a VS Code file over 20 MB, which OpenCode would refuse on every send", () => {
    expect(() => useInputStore.getState().addVSCodeFileAttachment("/workspace/map.bin", "map.bin", 20 * 1024 * 1024 + 1)).toThrow("map.bin")
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("does not attach a local file that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("rejects pending file and selection reads after switching drafts, even after returning", async () => {
    const source = { runtimeKey: "runtime", directory: "/repo", sessionId: "source" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(source)
    input.addRestoredAttachment({ url: "data:text/plain;base64,aGVsbG8=", mimeType: "text/plain", filename: "ready.txt" })
    const ready = useInputStore.getState().attachedFiles
    const local = input.addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    const selection = input.addVSCodeSelectionAttachment("/repo/code.ts", new File(["hello"], "selection.ts", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(2)
    input.selectAttachmentDraft({ ...source, sessionId: "other" })
    expect(useInputStore.getState().attachedFiles).toEqual([])
    input.selectAttachmentDraft(source)
    for (const reader of pendingReaders) resolveReader(reader, "data:text/plain;base64,aGVsbG8=")
    expect(await local).toBe(false)
    await selection
    expect(useInputStore.getState().attachedFiles).toBe(ready)
  })

  testWithMockFileReader("files an attachment into the named slot without taking the current one", async () => {
    const current = { runtimeKey: "runtime", directory: "/repo", sessionId: "current" }
    const composer = { runtimeKey: "runtime", directory: "/repo", sessionId: "fork" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(current)

    const addPromise = input.addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }), composer)
    await waitForReaderCount(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(input.getAttachedFiles()).toEqual([])
    expect(input.getAttachedFiles(composer).map((attachment) => attachment.filename)).toEqual(["hello.txt"])
    expect(useInputStore.getState().attachmentDraftKey).toBe(getChatDraftIdentityKey(current))
  })

  testWithMockFileReader("restores an attachment into the named slot", async () => {
    const current = { runtimeKey: "runtime", directory: "/repo", sessionId: "current" }
    const composer = { runtimeKey: "runtime", directory: "/repo", sessionId: "fork" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(current)

    input.addRestoredAttachment({ url: "data:text/plain;base64,aGVsbG8=", mimeType: "text/plain", filename: "ready.txt" }, composer)

    expect(input.getAttachedFiles()).toEqual([])
    expect(input.getAttachedFiles(composer).map((attachment) => attachment.filename)).toEqual(["ready.txt"])
  })

  testWithMockFileReader("keeps concurrent appends into the selected named slot", async () => {
    const target = { runtimeKey: "runtime", directory: "/repo", sessionId: "fork" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(target)
    const first = input.addAttachedFile(new File(["one"], "one.txt", { type: "text/plain" }), target)
    const second = input.addAttachedFile(new File(["two"], "two.txt", { type: "text/plain" }), target)
    await waitForReaderCount(2)
    resolveReader(pendingReaders[0], "data:text/plain;base64,b25l")
    expect(await first).toBe(true)
    resolveReader(pendingReaders[1], "data:text/plain;base64,dHdv")
    expect(await second).toBe(true)
    expect(input.getAttachedFiles(target).map((file) => file.filename)).toEqual(["one.txt", "two.txt"])
  })

  testWithMockFileReader("does not attach a local file after attached files are replaced", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().setAttachedFiles([])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("a pending selection in another draft does not block the same selection here", async () => {
    const source = { runtimeKey: "runtime", directory: "/repo", sessionId: "source" }
    const input = useInputStore.getState()
    const file = new File(["hello"], "selection.ts", { type: "text/plain" })
    input.selectAttachmentDraft(source)
    const first = input.addVSCodeSelectionAttachment("/repo/code.ts", file)
    input.selectAttachmentDraft({ ...source, sessionId: "other" })
    const second = input.addVSCodeSelectionAttachment("/repo/code.ts", file)
    expect(pendingReaders).toHaveLength(2)
    // A repeated selection of the current identity must not cancel its read.
    input.selectAttachmentDraft({ ...source, sessionId: "other" })
    input.clearAttachedFiles(source)
    for (const reader of pendingReaders) resolveReader(reader, "data:text/plain;base64,aGVsbG8=")
    await Promise.all([first, second])
    expect(useInputStore.getState().attachedFiles.map((attachment) => attachment.filename)).toEqual(["selection.ts"])
    input.selectAttachmentDraft(source)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("does not attach a local file after attached files are restored", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    const restored = new File(["restored"], "restored.txt", { type: "text/plain" })
    useInputStore.getState().setAttachedFiles([{
      id: "restored",
      file: restored,
      dataUrl: "data:text/plain;base64,cmVzdG9yZWQ=",
      mimeType: "text/plain",
      filename: "restored.txt",
      size: restored.size,
      source: "local",
    }])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["restored.txt"])
  })

  testWithMockFileReader("a selection added again comes back as the same attachment, whatever its chip is named", async () => {
    useInputStore.getState().clearAttachedFiles()
    const file = new File(["hello"], "app/[slug]/page.tsx:12", { type: "text/plain" })
    const first = useInputStore.getState().addVSCodeSelectionAttachment("/repo/app/[slug]/page.tsx", file)
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await first
    const [attached] = useInputStore.getState().attachedFiles
    expect(attached?.filename).toBe("app/(slug)/page.tsx:12")

    await useInputStore.getState().addVSCodeSelectionAttachment("/repo/app/[slug]/page.tsx", file)
    const again = useInputStore.getState().attachedFiles
    expect(again).toHaveLength(1)
    expect(again[0]?.filename).toBe(attached?.filename)
    expect(again[0]?.id).not.toBe(attached?.id)
  })

  testWithMockFileReader("does not attach a VS Code selection that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addVSCodeSelectionAttachment(
      "/workspace/hello.txt",
      new File(["hello"], "hello.txt", { type: "text/plain" })
    )
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("moves the selected draft's files onto another draft, merged with its own", () => {
    const parent = { runtimeKey: "runtime", directory: "/repo", sessionId: "parent" }
    const btw = { ...parent, sessionId: "btw-pending:parent" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(btw)
    input.addRestoredAttachment({ url: "data:text/plain;base64,aGVsbG8=", mimeType: "text/plain", filename: "earlier.txt" })
    input.selectAttachmentDraft(parent)
    input.addRestoredAttachment({ url: "data:image/png;base64,AQID", mimeType: "image/png", filename: "image-1.png" })

    input.moveAttachedFiles(parent, btw)

    expect(useInputStore.getState().attachedFiles).toEqual([])
    input.selectAttachmentDraft(btw)
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["earlier.txt", "image-1.png"])
    input.selectAttachmentDraft(parent)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("leaves files in place when the drafts are the same", () => {
    const parent = { runtimeKey: "runtime", directory: "/repo", sessionId: "parent" }
    const input = useInputStore.getState()
    input.selectAttachmentDraft(parent)
    input.addRestoredAttachment({ url: "data:image/png;base64,AQID", mimeType: "image/png", filename: "image-1.png" })
    input.moveAttachedFiles(parent, { ...parent })
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["image-1.png"])
  })

  test("does not leave local file reads pending after a reader error", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    rejectReader(pendingReaders[0])
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("cleans up pending VS Code selection keys after a reader error", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    const firstAdd = useInputStore.getState().addVSCodeSelectionAttachment("/workspace/hello.txt", file)
    expect(pendingReaders).toHaveLength(1)

    rejectReader(pendingReaders[0])
    await firstAdd

    const secondAdd = useInputStore.getState().addVSCodeSelectionAttachment("/workspace/hello.txt", file)
    expect(pendingReaders).toHaveLength(2)
    resolveReader(pendingReaders[1], "data:text/plain;base64,aGVsbG8=")
    await secondAdd

    expect(useInputStore.getState().attachedFiles.map((attached) => attached.filename)).toEqual(["hello.txt"])
  })

  testWithMockFileReader("normalizes code files to text/plain", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(
      new File(["const value = 1"], "example.ts", { type: "text/typescript" })
    )
    expect(pendingReaders).toHaveLength(1)

    resolveReader(pendingReaders[0], "data:text/typescript;base64,Y29uc3QgdmFsdWUgPSAx")

    expect(await addPromise).toBe(true)
    expect(useInputStore.getState().attachedFiles[0]?.filename).toBe("example.ts")
    expect(useInputStore.getState().attachedFiles[0]?.mimeType).toBe("text/plain")
    expect(useInputStore.getState().attachedFiles[0]?.dataUrl).toBe(
      "data:text/plain;base64,Y29uc3QgdmFsdWUgPSAx"
    )
  })

  testWithMockFileReader("normalizes structured text MIME types to text/plain", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(
      new File(["{}"], "example.json", { type: "application/json" })
    )
    expect(pendingReaders).toHaveLength(1)

    resolveReader(pendingReaders[0], "data:application/json;base64,e30=")

    expect(await addPromise).toBe(true)
    expect(useInputStore.getState().attachedFiles[0]?.mimeType).toBe("text/plain")
    expect(useInputStore.getState().attachedFiles[0]?.dataUrl).toBe("data:text/plain;base64,e30=")
  })

  testWithMockFileReader("keeps an unknown binary file in the draft without saving it anywhere", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles")
    try {
      const adding = useInputStore.getState().addAttachedFile(
        new File([new Uint8Array([0, 1, 2, 3])], "archive.zip", { type: "application/zip" }),
      )
      await waitForReaderCount(1)
      resolveReader(pendingReaders[0], "data:application/zip;base64,AAECAw==")
      expect(await adding).toBe(true)
      expect(write).not.toHaveBeenCalled()
      const [attached] = useInputStore.getState().attachedFiles
      expect(attached.filename).toBe("archive.zip")
      expect(attached.mimeType).toBe("application/zip")
      expect(attached.dataUrl).toBe("data:application/zip;base64,AAECAw==")
      expect(attached.agentPath).toBeUndefined()
    } finally {
      write.mockRestore()
    }
  })

  test("a malformed HAR is still rejected instead of sharing unsanitized content", async () => {
    const write = spyOn(opencodeClient, "writeOpenCodeTempFiles")
    try {
      const attached = await useInputStore.getState().addAttachedFile(
        new File([new Uint8Array([1, 2, 3, 65])], "secret.har", { type: "application/octet-stream" }),
      )
      expect(attached).toBe(false)
      expect(write).not.toHaveBeenCalled()
      expect(pendingReaders).toHaveLength(0)
    } finally {
      write.mockRestore()
    }
  })

  testWithMockFileReader("accepts an unknown MIME type when its contents are text", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(
      new File(["custom text"], "example.custom", { type: "application/octet-stream" })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pendingReaders).toHaveLength(1)

    resolveReader(pendingReaders[0], "data:application/octet-stream;base64,Y3VzdG9tIHRleHQ=")

    expect(await addPromise).toBe(true)
    expect(useInputStore.getState().attachedFiles[0]?.mimeType).toBe("text/plain")
    expect(useInputStore.getState().attachedFiles[0]?.dataUrl).toBe(
      "data:text/plain;base64,Y3VzdG9tIHRleHQ="
    )
  })

  testWithMockFileReader("preserves supported image MIME types", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(
      new File([new Uint8Array([1, 2, 3])], "image.webp", { type: "image/webp" })
    )
    expect(pendingReaders).toHaveLength(1)

    resolveReader(pendingReaders[0], "data:image/webp;base64,AQID")

    expect(await addPromise).toBe(true)
    expect(useInputStore.getState().attachedFiles[0]?.mimeType).toBe("image/webp")
    expect(useInputStore.getState().attachedFiles[0]?.dataUrl).toBe("data:image/webp;base64,AQID")
  })

  testWithMockFileReader("adds extracted document text and referenced images atomically", async () => {
    const archive = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>Diagram</w:t><a:blip r:embed="rId1"/></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="media/image.png" Type="image"/></Relationships>`),
      "word/media/image.png": pngBytes,
    })
    const addPromise = useInputStore.getState().addAttachedFile(new File([archive], "design.docx"))

    await waitForReaderCount(1)
    expect(pendingReaders).toHaveLength(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,RG9jdW1lbnQ=")
    await waitForReaderCount(2)
    expect(pendingReaders).toHaveLength(2)
    expect(useInputStore.getState().attachedFiles).toEqual([])
    resolveReader(pendingReaders[1], "data:image/png;base64,AQID")

    expect(await addPromise).toBe(true)
    expect(useInputStore.getState().attachedFiles.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    }))).toEqual([
      { filename: "design.docx", mimeType: "text/plain" },
      { filename: "design-image-1.png", mimeType: "image/png" },
    ])
  })

  testWithMockFileReader("regenerates document image names when the composer changes during preparation", async () => {
    const archive = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><a:blip r:embed="rId1"/></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="media/image.png" Type="image"/></Relationships>`),
      "word/media/image.png": pngBytes,
    })
    const addPromise = useInputStore.getState().addAttachedFile(new File([archive], "design.docx"))

    await waitForReaderCount(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,RG9jdW1lbnQ=")
    await waitForReaderCount(2)
    useInputStore.getState().addVSCodeFileAttachment("/workspace/design-image-1.png", "design-image-1.png", 1)
    resolveReader(pendingReaders[1], "data:image/png;base64,AQID")

    await waitForReaderCount(3)
    resolveReader(pendingReaders[2], "data:text/plain;base64,RG9jdW1lbnQ=")
    await waitForReaderCount(4)
    resolveReader(pendingReaders[3], "data:image/png;base64,AQID")

    expect(await addPromise).toBe(true)
    expect(useInputStore.getState().attachedFiles.map((attachment) => attachment.filename)).toEqual([
      "design-image-1.png",
      "design.docx",
      "design-image-2.png",
    ])
    const textAttachment = useInputStore.getState().attachedFiles[1]
    expect((await textAttachment?.file.text())?.includes("[design-image-2.png]")).toBe(true)
  })

  testWithMockFileReader("extracted document entries share a sourceDocumentId for cascade removal", async () => {
    const archive = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>Diagram</w:t><a:blip r:embed="rId1"/></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="media/image.png" Type="image"/></Relationships>`),
      "word/media/image.png": pngBytes,
    })
    const addPromise = useInputStore.getState().addAttachedFile(new File([archive], "design.docx"))

    await waitForReaderCount(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,RG9jdW1lbnQ=")
    await waitForReaderCount(2)
    resolveReader(pendingReaders[1], "data:image/png;base64,AQID")

    expect(await addPromise).toBe(true)
    const files = useInputStore.getState().attachedFiles
    expect(files).toHaveLength(2)
    expect(files[0].filename).toBe("design.docx")
    expect(files[1].filename).toBe("design-image-1.png")

    // All entries from the same document extraction share the same sourceDocumentId
    expect(files[0].sourceDocumentId).toBeDefined()
    expect(files[0].sourceDocumentId).toBe(files[1].sourceDocumentId)

    // Removing any entry in the group cascade-removes all entries
    useInputStore.getState().removeAttachedFile(files[0].id)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("removing an extracted image child also cascade-removes the document group", async () => {
    const archive = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>Diagram</w:t><a:blip r:embed="rId1"/></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="media/image.png" Type="image"/></Relationships>`),
      "word/media/image.png": pngBytes,
    })
    const addPromise = useInputStore.getState().addAttachedFile(new File([archive], "design.docx"))

    await waitForReaderCount(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,RG9jdW1lbnQ=")
    await waitForReaderCount(2)
    resolveReader(pendingReaders[1], "data:image/png;base64,AQID")

    expect(await addPromise).toBe(true)
    const files = useInputStore.getState().attachedFiles
    expect(files).toHaveLength(2)
    expect(files[0].filename).toBe("design.docx")
    expect(files[1].filename).toBe("design-image-1.png")

    // Removing the image child also cascade-removes the entire group
    useInputStore.getState().removeAttachedFile(files[1].id)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("non-document attachments do not have sourceDocumentId and remove individually", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(
      new File(["hello"], "hello.txt", { type: "text/plain" })
    )
    expect(pendingReaders).toHaveLength(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")

    expect(await addPromise).toBe(true)
    const files = useInputStore.getState().attachedFiles
    expect(files).toHaveLength(1)
    expect(files[0].sourceDocumentId).toBe(undefined)

    useInputStore.getState().removeAttachedFile(files[0].id)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("PPTX slide extraction cascades removal of all slide images", async () => {
    const archive = zipSync({
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="../media/image1.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>`),
      "ppt/media/image1.png": pngBytes,
    })
    const addPromise = useInputStore.getState().addAttachedFile(new File([archive], "deck.pptx"))

    await waitForReaderCount(1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,RG9jdW1lbnQ=")
    await waitForReaderCount(2)
    resolveReader(pendingReaders[1], "data:image/png;base64,AQID")

    expect(await addPromise).toBe(true)
    const files = useInputStore.getState().attachedFiles
    expect(files).toHaveLength(2)
    expect(files[0].filename).toBe("deck.pptx")
    expect(files[1].filename).toBe("deck-image-1.png")
    expect(files[0].sourceDocumentId).toBeDefined()
    expect(files[0].sourceDocumentId).toBe(files[1].sourceDocumentId)

    // Removing the text entry cascades to the slide image
    useInputStore.getState().removeAttachedFile(files[0].id)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })
})

describe("input-store guest attach", () => {
  beforeEach(() => {
    useInputStore.setState({ pendingGuestIssue: null })
  })

  test("holds a guest issue until the composer consumes it", () => {
    const issue = {
      providerId: "clickup",
      id: "abc",
      title: "Login",
      url: "https://app.clickup.com/t/abc",
    }
    useInputStore.getState().setPendingGuestIssue(issue)
    expect(useInputStore.getState().pendingGuestIssue).toEqual(issue)
    expect(useInputStore.getState().consumePendingGuestIssue()).toEqual(issue)
    expect(useInputStore.getState().pendingGuestIssue).toBeNull()
    expect(useInputStore.getState().consumePendingGuestIssue()).toBeNull()
  })

  test("holds a guest pull with author and branches", () => {
    const pull = {
      providerId: "gitlab",
      id: "!12",
      title: "Fix login",
      url: "https://gitlab.com/acme/app/-/merge_requests/12",
      kind: "pull" as const,
      author: "ada",
      branches: { head: "feature", base: "main" },
    }
    useInputStore.getState().setPendingGuestIssue(pull)
    expect(useInputStore.getState().pendingGuestIssue).toEqual(pull)
    expect(useInputStore.getState().consumePendingGuestIssue()).toEqual(pull)
  })
})

describe("input-store BTW composer requests", () => {
  test("keeps the request scoped to its parent without changing the normal composer", () => {
    useInputStore.setState({
      pendingInputText: "normal draft",
      pendingInputMode: "replace",
      pendingBtwComposerRequest: null,
      attachedFiles: [],
    })
    useInputStore.getState().requestBtwComposer({
      parentSessionId: "parent-1",
      text: "> selected text",
    })

    expect(useInputStore.getState().consumePendingBtwComposerRequest("parent-2")).toBeNull()
    expect(useInputStore.getState().pendingInputText).toBe("normal draft")
    expect(useInputStore.getState().consumePendingBtwComposerRequest("parent-1")).toEqual({
      parentSessionId: "parent-1",
      text: "> selected text",
    })
    expect(useInputStore.getState().consumePendingBtwComposerRequest("parent-1")).toBeNull()
    expect(useInputStore.getState().pendingInputText).toBe("normal draft")
  })
})

describe("input-store pinned composer addressing", () => {
  beforeEach(() => {
    useInputStore.setState({
      pendingInputText: null,
      pendingInputMode: "replace",
      pendingInputTarget: null,
      pendingSyntheticParts: null,
      pinnedSyntheticParts: new Map(),
      attachedFiles: [],
      attachmentDraftKey: null,
      attachmentDrafts: new Map(),
    })
  })

  test("app-wide text reaches the main composer and never a pinned one", () => {
    useInputStore.getState().setPendingInputText("from a plugin", "append")

    expect(useInputStore.getState().consumePendingInputText("ses_pinned")).toBeNull()
    expect(useInputStore.getState().consumePendingInputText()).toEqual({ text: "from a plugin", mode: "append" })
    expect(useInputStore.getState().pendingInputTarget).toBeNull()
  })

  test("text quoted in a pinned chat reaches only that chat's composer", () => {
    useInputStore.getState().setPendingInputText("> quoted", "append", "ses_pinned")

    expect(useInputStore.getState().consumePendingInputText()).toBeNull()
    expect(useInputStore.getState().consumePendingInputText("ses_other")).toBeNull()
    expect(useInputStore.getState().consumePendingInputText("ses_pinned")).toEqual({ text: "> quoted", mode: "append" })
    expect(useInputStore.getState().consumePendingInputText("ses_pinned")).toBeNull()
  })

  test("pending context of the main and a pinned composer stays apart", () => {
    const main = [{ text: "main context" }]
    const pinned = [{ text: "pinned context" }]
    useInputStore.getState().setPendingSyntheticParts(main)
    useInputStore.getState().setPendingSyntheticParts(pinned, "ses_pinned")

    expect(useInputStore.getState().getPendingSyntheticParts()).toBe(main)
    expect(useInputStore.getState().consumePendingSyntheticParts("ses_pinned")).toBe(pinned)
    expect(useInputStore.getState().getPendingSyntheticParts("ses_pinned")).toBeNull()
    expect(useInputStore.getState().consumePendingSyntheticParts()).toBe(main)
    expect(useInputStore.getState().pendingSyntheticParts).toBeNull()
  })

  test("moving the selected attachment slot between two composers keeps both drafts' files", () => {
    const main = { runtimeKey: "runtime", directory: "/repo", sessionId: "ses_main" }
    const pinned = { runtimeKey: "runtime", directory: "/repo", sessionId: "ses_pinned" }
    const file = (id: string) => ({
      id, file: new File([], `${id}.txt`), dataUrl: "", mimeType: "text/plain", filename: `${id}.txt`, size: 0, source: "local" as const,
    })
    const store = useInputStore.getState()
    store.selectAttachmentDraft(main)
    store.setAttachedFiles([file("a")])
    store.setAttachedFiles([file("b")], pinned)

    useInputStore.getState().selectAttachmentDraft(pinned)
    expect(useInputStore.getState().attachedFiles.map((entry) => entry.id)).toEqual(["b"])
    expect(useInputStore.getState().attachmentDrafts.get(getChatDraftIdentityKey(main))?.map((entry) => entry.id)).toEqual(["a"])

    useInputStore.getState().selectAttachmentDraft(main)
    expect(useInputStore.getState().attachedFiles.map((entry) => entry.id)).toEqual(["a"])
    expect(useInputStore.getState().attachmentDrafts.get(getChatDraftIdentityKey(pinned))?.map((entry) => entry.id)).toEqual(["b"])
  })
})

describe("input-store draft submit", () => {
  beforeEach(() => {
    useInputStore.setState({ pendingDraftSubmit: null })
  })

  test("the requested draft takes its first message once", () => {
    useInputStore.getState().requestDraftSubmit(7, "Fix the build")

    expect(useInputStore.getState().consumePendingDraftSubmit(7)).toBe("Fix the build")
    expect(useInputStore.getState().consumePendingDraftSubmit(7)).toBeNull()
  })

  test("another draft or a session drops the message instead of sending it", () => {
    useInputStore.getState().requestDraftSubmit(7, "Fix the build")
    expect(useInputStore.getState().consumePendingDraftSubmit(8)).toBeNull()
    expect(useInputStore.getState().pendingDraftSubmit).toBeNull()

    useInputStore.getState().requestDraftSubmit(7, "Fix the build")
    expect(useInputStore.getState().consumePendingDraftSubmit(null)).toBeNull()
    expect(useInputStore.getState().pendingDraftSubmit).toBeNull()
  })
})

describe("input-store draft content", () => {
  const file = new File(["shared"], "notes.txt", { type: "text/plain" })

  beforeEach(() => {
    useInputStore.setState({ pendingDraftContent: null })
  })

  test("the requested draft takes the files and the text once", () => {
    useInputStore.getState().requestDraftContent(7, { files: [file], text: "  https://example.com/x  " })

    expect(useInputStore.getState().consumePendingDraftContent(7)).toEqual({
      files: [file],
      text: "https://example.com/x",
      rejected: [],
    })
    expect(useInputStore.getState().consumePendingDraftContent(7)).toBeNull()
  })

  test("a text-only share carries no files", () => {
    useInputStore.getState().requestDraftContent(7, { files: [], text: "Summarise this" })

    expect(useInputStore.getState().consumePendingDraftContent(7)).toEqual({
      files: [],
      text: "Summarise this",
      rejected: [],
    })
  })

  test("blank text is stored as none", () => {
    useInputStore.getState().requestDraftContent(7, { files: [file], text: "   " })

    expect(useInputStore.getState().consumePendingDraftContent(7)).toEqual({ files: [file], text: null, rejected: [] })
  })

  test("a refusal the native side reported travels with the share", () => {
    const rejected = [{ name: "huge.zip", reason: "too-large" }]
    useInputStore.getState().requestDraftContent(7, { files: [file], rejected })

    expect(useInputStore.getState().consumePendingDraftContent(7)?.rejected).toEqual(rejected)
  })

  test("another draft asking leaves the content for the draft it was requested for", () => {
    useInputStore.getState().requestDraftContent(7, { files: [file], text: "hello" })
    expect(useInputStore.getState().consumePendingDraftContent(8)).toBeNull()
    expect(useInputStore.getState().pendingDraftContent).not.toBeNull()

    expect(useInputStore.getState().consumePendingDraftContent(null)).toBeNull()
    expect(useInputStore.getState().consumePendingDraftContent(7)).toEqual({
      files: [file],
      text: "hello",
      rejected: [],
    })
    expect(useInputStore.getState().pendingDraftContent).toBeNull()
  })
})

describe("input-store draft dictation", () => {
  beforeEach(() => {
    useInputStore.setState({ pendingDraftDictation: null })
  })

  test("the requested draft starts recording once", () => {
    useInputStore.getState().requestDraftDictation(7)

    expect(useInputStore.getState().consumePendingDraftDictation(7)).toBe(true)
    expect(useInputStore.getState().consumePendingDraftDictation(7)).toBe(false)
  })

  test("another draft leaves the request for the draft it was made for", () => {
    useInputStore.getState().requestDraftDictation(7)

    expect(useInputStore.getState().consumePendingDraftDictation(8)).toBe(false)
    expect(useInputStore.getState().pendingDraftDictation).toEqual({ draftId: 7 })
    expect(useInputStore.getState().consumePendingDraftDictation(7)).toBe(true)
  })
})
