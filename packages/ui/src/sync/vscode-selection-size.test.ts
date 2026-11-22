import { describe, expect, test } from "bun:test"
import { isVSCodeSelectionWithinLimit, MAX_VSCODE_SELECTION_BYTES } from "./vscode-selection-size"

describe("VS Code selection size", () => {
  test("accepts text just below and exactly at the UTF-8 byte limit", () => {
    expect(isVSCodeSelectionWithinLimit("a".repeat(MAX_VSCODE_SELECTION_BYTES - 1))).toBe(true)
    expect(isVSCodeSelectionWithinLimit("a".repeat(MAX_VSCODE_SELECTION_BYTES))).toBe(true)
  })

  test("rejects text just above the UTF-8 byte limit without encoding it", () => {
    expect(isVSCodeSelectionWithinLimit("a".repeat(MAX_VSCODE_SELECTION_BYTES + 1))).toBe(false)
  })

  test("counts multibyte and supplementary characters as UTF-8 bytes", () => {
    expect(isVSCodeSelectionWithinLimit("é".repeat(MAX_VSCODE_SELECTION_BYTES / 2))).toBe(true)
    expect(isVSCodeSelectionWithinLimit("😀".repeat(MAX_VSCODE_SELECTION_BYTES / 4))).toBe(true)
    expect(isVSCodeSelectionWithinLimit("😀".repeat(MAX_VSCODE_SELECTION_BYTES / 4 + 1))).toBe(false)
  })
})
