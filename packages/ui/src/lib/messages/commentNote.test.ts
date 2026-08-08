import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  formatCommentNote,
  getPartInlineComment,
  getRedundantCommentFileUrls,
  parseDesktopCommentNote,
  parseOpenChamberCommentNote,
  readCommentMetadata,
} from "./commentNote"

const metadataPart = (overrides?: Record<string, unknown>): Part =>
  ({
    id: "prt_1",
    type: "text",
    synthetic: true,
    text: "The user made the following comment regarding line 16 of cmd/css.go: hi",
    metadata: {
      opencodeComment: {
        path: "cmd/css.go",
        selection: { startLine: 16, endLine: 16, startChar: 0, endChar: 0 },
        comment: "hi",
        preview: "const x = 1",
        origin: "file",
        ...overrides,
      },
    },
  }) as unknown as Part

const filePart = (url: string): Part =>
  ({ id: "prt_f", type: "file", mime: "text/plain", filename: "css.go", url }) as unknown as Part

const plainText = (text: string, synthetic = false): Part =>
  ({ id: "prt_t", type: "text", text, ...(synthetic ? { synthetic: true } : {}) }) as unknown as Part

describe("readCommentMetadata", () => {
  test("reads a well-formed opencodeComment", () => {
    const result = readCommentMetadata((metadataPart() as { metadata?: unknown }).metadata)
    expect(result?.path).toBe("cmd/css.go")
    expect(result?.comment).toBe("hi")
    expect(result?.selection).toEqual({ startLine: 16, endLine: 16 })
  })

  test("returns undefined for missing or malformed metadata", () => {
    expect(readCommentMetadata(undefined)).toBe(undefined)
    expect(readCommentMetadata({})).toBe(undefined)
    expect(readCommentMetadata({ opencodeComment: { path: "a" } })).toBe(undefined)
  })
})

describe("formatCommentNote / parseDesktopCommentNote round-trip", () => {
  test("single line", () => {
    const text = formatCommentNote({ path: "cmd/css.go", startLine: 16, endLine: 16, comment: "hi there" })
    expect(text).toBe("The user made the following comment regarding line 16 of cmd/css.go: hi there")
    const parsed = parseDesktopCommentNote(text)
    expect(parsed).toEqual({ path: "cmd/css.go", comment: "hi there", selection: { startLine: 16, endLine: 16 } })
  })

  test("line range", () => {
    const text = formatCommentNote({ path: "a/b.ts", startLine: 5, endLine: 9, comment: "review this" })
    expect(text).toBe("The user made the following comment regarding lines 5 through 9 of a/b.ts: review this")
    expect(parseDesktopCommentNote(text)?.selection).toEqual({ startLine: 5, endLine: 9 })
  })

  test("no selection yields 'this file'", () => {
    const text = formatCommentNote({ path: "a/b.ts", comment: "general note" })
    expect(text).toBe("The user made the following comment regarding this file of a/b.ts: general note")
    expect(parseDesktopCommentNote(text)?.selection).toBe(undefined)
  })
})

describe("parseOpenChamberCommentNote", () => {
  test("parses the legacy OpenChamber fenced format", () => {
    const text = "Comment on `css.go` lines 16-18:\n```go\nconst x = 1\n```\n\nlooks off"
    const parsed = parseOpenChamberCommentNote(text)
    expect(parsed?.path).toBe("css.go")
    expect(parsed?.comment).toBe("looks off")
    expect(parsed?.selection).toEqual({ startLine: 16, endLine: 18 })
  })

  test("ignores unrelated text", () => {
    expect(parseOpenChamberCommentNote("just a normal message")).toBe(undefined)
  })
})

describe("getPartInlineComment", () => {
  test("resolves from metadata first", () => {
    expect(getPartInlineComment(metadataPart())?.comment).toBe("hi")
  })

  test("falls back to parsing the OpenCode text format when metadata is absent", () => {
    const part = plainText("The user made the following comment regarding line 3 of x.ts: ship it", true)
    expect(getPartInlineComment(part)?.comment).toBe("ship it")
  })

  test("ignores non-text parts and ordinary messages", () => {
    expect(getPartInlineComment(filePart("file:///x.ts"))).toBe(undefined)
    expect(getPartInlineComment(plainText("can you see my comments?"))).toBe(undefined)
  })
})

describe("getRedundantCommentFileUrls", () => {
  test("suppresses a line-anchored file chip that matches a comment", () => {
    const parts = [
      metadataPart(),
      filePart("file:///home/me/repo/cmd/css.go?start=16&end=16"),
    ]
    const result = getRedundantCommentFileUrls(parts)
    expect(result.has("file:///home/me/repo/cmd/css.go?start=16&end=16")).toBe(true)
  })

  test("keeps file chips with no matching comment line", () => {
    const parts = [
      metadataPart(),
      filePart("file:///home/me/repo/cmd/css.go?start=99&end=99"),
      filePart("file:///home/me/repo/other.ts"),
    ]
    expect(getRedundantCommentFileUrls(parts).size).toBe(0)
  })

  test("returns an empty set when there are no comments", () => {
    expect(getRedundantCommentFileUrls([filePart("file:///x.ts?start=1&end=1")]).size).toBe(0)
  })

  test("does not suppress a file whose name is only a suffix of the comment path", () => {
    const parts = [
      metadataPart({ path: "config.ts", selection: { startLine: 5, endLine: 5, startChar: 0, endChar: 0 } }),
      filePart("file:///repo/myconfig.ts?start=5&end=5"),
    ]
    expect(getRedundantCommentFileUrls(parts).size).toBe(0)
  })
})
