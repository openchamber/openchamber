import { beforeEach, describe, expect, test } from "bun:test"
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
})
