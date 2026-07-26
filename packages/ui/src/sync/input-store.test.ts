import { beforeEach, describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { useInputStore } from "./input-store"

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

describe("input-store attachments", () => {
  beforeEach(() => {
    pendingReaders.length = 0
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader
    useInputStore.setState({
      pendingInputText: null,
      pendingInputMode: "replace",
      pendingSyntheticParts: null,
      activeEditorFile: null,
    })
    useInputStore.getState().setAttachedFiles([])
  })

  testWithMockFileReader("does not attach a local file that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("does not attach a local file after attached files are replaced", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().setAttachedFiles([])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

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

  test("rejects an unknown binary file after inspecting its contents", async () => {
    const attached = await useInputStore.getState().addAttachedFile(
      new File([new Uint8Array([0, 1, 2, 3])], "archive.bin", { type: "application/octet-stream" })
    )

    expect(attached).toBe(false)
    expect(pendingReaders).toHaveLength(0)
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("rejects unknown content with too many control bytes", async () => {
    const attached = await useInputStore.getState().addAttachedFile(
      new File([new Uint8Array([1, 2, 3, 65])], "encoded.custom", { type: "application/octet-stream" })
    )

    expect(attached).toBe(false)
    expect(pendingReaders).toHaveLength(0)
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
    expect(files[0].sourceDocumentId).toBeUndefined()

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
