import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { isSyntheticPart, isFullySyntheticMessage, filterSyntheticParts } from "./synthetic"

function createTextPart(id: string, text: string, synthetic?: boolean): Part {
  return {
    id,
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text,
    ...(synthetic !== undefined ? { synthetic } : {}),
  } as Part
}

function createFilePart(id: string, url: string): Part {
  return {
    id,
    sessionID: "session-1",
    messageID: "message-1",
    type: "file",
    mime: "text/plain",
    url,
  } as Part
}

describe("isSyntheticPart", () => {
  test("returns false for undefined", () => {
    expect(isSyntheticPart(undefined)).toBe(false)
  })

  test("returns false for non-object", () => {
    expect(isSyntheticPart(null as unknown as Part)).toBe(false)
    expect(isSyntheticPart("string" as unknown as Part)).toBe(false)
  })

  test("returns false for parts without synthetic property", () => {
    const part = createTextPart("1", "hello")
    expect(isSyntheticPart(part)).toBe(false)
  })

  test("returns false for parts with synthetic: false", () => {
    const part = createTextPart("1", "hello", false)
    expect(isSyntheticPart(part)).toBe(false)
  })

  test("returns true for parts with synthetic: true", () => {
    const part = createTextPart("1", "file content here", true)
    expect(isSyntheticPart(part)).toBe(true)
  })

  test("returns false for file parts", () => {
    const part = createFilePart("1", "file:///path/to/file")
    expect(isSyntheticPart(part)).toBe(false)
  })
})

describe("isFullySyntheticMessage", () => {
  test("returns false for undefined", () => {
    expect(isFullySyntheticMessage(undefined)).toBe(false)
  })

  test("returns false for empty array", () => {
    expect(isFullySyntheticMessage([])).toBe(false)
  })

  test("returns false when all parts are non-synthetic", () => {
    const parts = [
      createTextPart("1", "hello"),
      createFilePart("2", "file:///path"),
    ]
    expect(isFullySyntheticMessage(parts)).toBe(false)
  })

  test("returns false when some parts are synthetic", () => {
    const parts = [
      createTextPart("1", "user prompt"),
      createTextPart("2", "file content", true),
    ]
    expect(isFullySyntheticMessage(parts)).toBe(false)
  })

  test("returns true when all parts are synthetic", () => {
    const parts = [
      createTextPart("1", "file content 1", true),
      createTextPart("2", "file content 2", true),
    ]
    expect(isFullySyntheticMessage(parts)).toBe(true)
  })
})

describe("filterSyntheticParts", () => {
  test("returns empty array for undefined", () => {
    expect(filterSyntheticParts(undefined)).toEqual([])
  })

  test("returns empty array for empty array", () => {
    expect(filterSyntheticParts([])).toEqual([])
  })

  test("returns all parts when no synthetic parts exist", () => {
    const parts = [
      createTextPart("1", "hello"),
      createFilePart("2", "file:///path"),
    ]
    expect(filterSyntheticParts(parts)).toEqual(parts)
  })

  test("filters out synthetic parts when non-synthetic parts exist", () => {
    const userPart = createTextPart("1", "user prompt")
    const syntheticPart = createTextPart("2", "file content", true)
    const parts = [userPart, syntheticPart]
    expect(filterSyntheticParts(parts)).toEqual([userPart])
  })

  test("keeps synthetic parts when all parts are synthetic", () => {
    const parts = [
      createTextPart("1", "file content 1", true),
      createTextPart("2", "file content 2", true),
    ]
    expect(filterSyntheticParts(parts)).toEqual(parts)
  })
})
