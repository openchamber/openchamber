export const MAX_VSCODE_SELECTION_BYTES = 1024 * 1024

/** Check UTF-8 size without allocating a second copy of the selected text. */
export const isVSCodeSelectionWithinLimit = (text: string): boolean => {
  let bytes = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes > MAX_VSCODE_SELECTION_BYTES) return false
  }
  return true
}
