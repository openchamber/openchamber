import { describe, expect, test } from 'bun:test'
import { isVSCodeSelectionWithinLimit, MAX_VSCODE_SELECTION_BYTES } from './selection-size'

describe('VS Code extension selection size', () => {
  test('accepts text at the limit and rejects text one byte above it', () => {
    expect(isVSCodeSelectionWithinLimit('a'.repeat(MAX_VSCODE_SELECTION_BYTES))).toBe(true)
    expect(isVSCodeSelectionWithinLimit('a'.repeat(MAX_VSCODE_SELECTION_BYTES + 1))).toBe(false)
  })

  test('counts multibyte characters by their UTF-8 size', () => {
    expect(isVSCodeSelectionWithinLimit('é'.repeat(MAX_VSCODE_SELECTION_BYTES / 2))).toBe(true)
    expect(isVSCodeSelectionWithinLimit('😀'.repeat(MAX_VSCODE_SELECTION_BYTES / 4 + 1))).toBe(false)
  })
})
