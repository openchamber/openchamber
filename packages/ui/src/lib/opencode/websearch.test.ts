import { describe, expect, test } from "bun:test"

import type { Config, FormRequest } from "./model"
import {
  parseWebSearchOutput,
  readWebSearchConsent,
  readWebSearchSelection,
  webSearchProviderOf,
  webSearchSelectionToConfig,
} from "./websearch"

// The exact text OpenCode 2.0.15's websearch tool returns
// (packages/core/src/tool/plugin/websearch.ts).
const TWO_RESULTS = [
  "## [Effect Schema docs](https://www.effect.website/docs/schema)",
  "Published: 2026-09-01T10:00:00.000Z",
  "",
  "Schema describes the structure of your data.",
  "It decodes and encodes.",
  "",
  "## [https://example.com/no-title](https://example.com/no-title)",
  "",
  "Snippet without a date.",
].join("\n")

describe("parseWebSearchOutput", () => {
  test("reads one card per result with host, date and snippet", () => {
    expect(parseWebSearchOutput(TWO_RESULTS)).toEqual({
      kind: "results",
      results: [
        {
          url: "https://www.effect.website/docs/schema",
          host: "effect.website",
          title: "Effect Schema docs",
          published: "2026-09-01T10:00:00.000Z",
          snippet: "Schema describes the structure of your data.\nIt decodes and encodes.",
        },
        {
          url: "https://example.com/no-title",
          host: "example.com",
          title: null,
          published: null,
          snippet: "Snippet without a date.",
        },
      ],
    })
  })

  test("a result with neither date nor snippet still reads", () => {
    expect(parseWebSearchOutput("## [Only a title](https://a.dev/x)")).toEqual({
      kind: "results",
      results: [{ url: "https://a.dev/x", host: "a.dev", title: "Only a title", published: null, snippet: null }],
    })
  })

  test("a title holding brackets keeps them", () => {
    const output = parseWebSearchOutput("## [Array [T] in TS](https://a.dev/x)")
    expect(output?.kind === "results" ? output.results[0]?.title : null).toBe("Array [T] in TS")
  })

  test("OpenCode's no-results text is an empty result, not a parse failure", () => {
    expect(parseWebSearchOutput("No search results found. Please try a different query.")).toEqual({ kind: "empty" })
  })

  test("anything else falls back to the text renderer", () => {
    expect(parseWebSearchOutput("Some other format")).toBeNull()
    expect(parseWebSearchOutput("intro\n## [Title](https://a.dev)")).toBeNull()
    expect(parseWebSearchOutput("## [Title](ftp://a.dev)")).toBeNull()
  })
})

describe("webSearchProviderOf", () => {
  test("reads the provider id OpenCode records, nothing else", () => {
    expect(webSearchProviderOf({ provider: "exa" })).toBe("exa")
    expect(webSearchProviderOf({ provider: "" })).toBeNull()
    expect(webSearchProviderOf({ provider: 1 })).toBeNull()
    expect(webSearchProviderOf(undefined)).toBeNull()
  })
})

describe("web search choice", () => {
  // SAFETY: fixtures; every Config field is optional and the provider id is a
  // branded string on the wire, which a literal cannot carry without a cast.
  const config = (websearch: Config["websearch"]): Config => ({ websearch }) as Config
  // SAFETY: as above, a literal provider id standing in for the branded wire value.
  const choice = (provider: string) => ({ provider }) as NonNullable<Config["websearch"]>

  test("reads every shape of the websearch config key", () => {
    expect(readWebSearchSelection(config(undefined))).toEqual({ kind: "default" })
    expect(readWebSearchSelection(config(false))).toEqual({ kind: "off" })
    expect(readWebSearchSelection(config(choice("random")))).toEqual({ kind: "random" })
    expect(readWebSearchSelection(config(choice("exa")))).toEqual({ kind: "provider", id: "exa" })
  })

  test("writes the body the config route takes", () => {
    expect(webSearchSelectionToConfig({ kind: "default" })).toBeNull()
    expect(webSearchSelectionToConfig({ kind: "off" })).toBe(false)
    expect(webSearchSelectionToConfig({ kind: "random" })).toBe("random")
    expect(webSearchSelectionToConfig({ kind: "provider", id: "tavily" })).toBe("tavily")
  })
})

describe("readWebSearchConsent", () => {
  // SAFETY: fixture shaped like OpenCode 2.0.15's consent form; ids are branded on the wire.
  const form = (overrides: Partial<FormRequest>): FormRequest => ({
    id: "frm_1",
    sessionID: "ses_1",
    title: "Web Search",
    metadata: { kind: "websearch.provider" },
    fields: [
      {
        key: "choice",
        type: "string",
        description: "Allow OpenCode to search the web for up-to-date information?",
        required: true,
        custom: false,
        options: [
          { value: "allow", label: "Allow search via Exa, Tavily" },
          { value: "choose", label: "Choose another provider" },
          { value: "disable", label: "Disable web search" },
        ],
      },
    ],
    ...overrides,
  }) as FormRequest

  test("recognizes the first-use question", () => {
    expect(readWebSearchConsent(form({}))).toEqual({
      step: "choice",
      fieldKey: "choice",
      options: [
        { value: "allow", label: "Allow search via Exa, Tavily" },
        { value: "choose", label: "Choose another provider" },
        { value: "disable", label: "Disable web search" },
      ],
    })
  })

  test("recognizes the provider list that follows 'choose'", () => {
    const consent = readWebSearchConsent(form({
      title: "Choose a web search provider",
      fields: [{ key: "provider", type: "string", required: true, custom: false, options: [{ value: "exa", label: "Exa" }] }],
    }))
    expect(consent).toEqual({ step: "provider", fieldKey: "provider", options: [{ value: "exa", label: "Exa" }] })
  })

  test("leaves every other form to the generic card", () => {
    expect(readWebSearchConsent(form({ metadata: undefined }))).toBeNull()
    expect(readWebSearchConsent(form({ metadata: { kind: "other" } }))).toBeNull()
    expect(readWebSearchConsent(form({ fields: [{ key: "choice", type: "boolean" }] }))).toBeNull()
  })
})
