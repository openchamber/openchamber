import { describe, expect, test } from "bun:test"
import type { InlineCommentDraft } from "@/stores/useInlineCommentDraftStore"
import { appendInlineComments, buildInlineCommentParts } from "./inlineComments"

const draft = (overrides: Partial<InlineCommentDraft>): InlineCommentDraft => ({
  id: "icd-1",
  sessionKey: "sess-1",
  source: "file",
  fileLabel: "cmd/css.go:16-18",
  startLine: 16,
  endLine: 18,
  code: "const x = 1",
  language: "go",
  text: "please fix this",
  createdAt: 0,
  ...overrides,
})

describe("buildInlineCommentParts (OpenCode Desktop card parity)", () => {
  test("file draft becomes an opencodeComment synthetic part with origin 'file'", () => {
    const [part] = buildInlineCommentParts([draft({ source: "file" })])
    expect(part.synthetic).toBe(true)
    expect(part.metadata?.opencodeComment.origin).toBe("file")
    // The `:16-18` line suffix is stripped from fileLabel to form the path.
    expect(part.metadata?.opencodeComment.path).toBe("cmd/css.go")
    expect(part.metadata?.opencodeComment.comment).toBe("please fix this")
    expect(part.metadata?.opencodeComment.preview).toBe("const x = 1")
    expect(part.metadata?.opencodeComment.selection).toEqual({
      startLine: 16,
      endLine: 18,
      startChar: 0,
      endChar: 0,
    })
  })

  test("diff draft gets origin 'review'", () => {
    const [part] = buildInlineCommentParts([draft({ source: "diff", side: "modified" })])
    expect(part.metadata?.opencodeComment.origin).toBe("review")
  })

  test("plan draft gets origin 'file' (only diff maps to review)", () => {
    const [part] = buildInlineCommentParts([draft({ source: "plan", fileLabel: "plan" })])
    expect(part.metadata?.opencodeComment.origin).toBe("file")
  })

  test("preview-console/annotation are plain synthetic parts with NO comment metadata", () => {
    const parts = buildInlineCommentParts([
      draft({ source: "preview-console" }),
      draft({ source: "preview-annotation" }),
    ])
    for (const part of parts) {
      expect(part.synthetic).toBe(true)
      expect(part.metadata).toBe(undefined)
    }
  })
})

describe("appendInlineComments (terminal vs text split)", () => {
  const terminalDraft = draft({
    source: "terminal",
    fileLabel: "Build",
    language: "term-1",
    code: "compile failed",
    text: "",
  })

  test("returns text unchanged when there are no drafts", () => {
    expect(appendInlineComments("hello", [])).toBe("hello")
  })

  test("terminal drafts serialize into a <terminal_context> block", () => {
    const out = appendInlineComments("fix this", [terminalDraft])
    expect(out).toContain("fix this")
    expect(out).toContain("<terminal_context>")
    expect(out).toContain("compile failed")
  })

  test("non-terminal drafts serialize as fenced comment text (not terminal_context)", () => {
    const out = appendInlineComments("", [draft({ source: "file" })])
    expect(out).toContain("Comment on")
    expect(out).toContain("const x = 1")
    expect(out).not.toContain("<terminal_context>")
  })

  test("mixed drafts keep both encodings", () => {
    const out = appendInlineComments("hello", [draft({ source: "file" }), terminalDraft])
    expect(out).toContain("Comment on")
    expect(out).toContain("<terminal_context>")
  })
})
