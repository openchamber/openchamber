import { describe, expect, test } from "bun:test"

import type { IntegrationInfo } from "@opencode/client"
import type { Config, FormRequest } from "./model"
import {
  isWebSearchIntegration,
  parseWebSearchOutput,
  projectWebSearchAccounts,
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

describe("projectWebSearchAccounts", () => {
  const integration = (id: string, name: string, overrides: Partial<IntegrationInfo> = {}): IntegrationInfo => ({
    id,
    name,
    methods: [],
    connections: [],
    ...overrides,
  })
  const keyAndEnv = (env: string): IntegrationInfo["methods"] => [
    { type: "key", label: "API key" },
    { type: "env", names: [env] },
  ]
  const searxng = integration("searxng", "SearXNG", {
    metadata: { websearch: true },
    methods: [
      {
        id: "server",
        type: "external",
        label: "Your SearXNG server",
        form: [{ key: "url", type: "string", format: "uri", title: "Server URL", placeholder: "https://searx.example.org", required: true }],
      },
      { type: "env", names: ["SEARXNG_URL"] },
    ],
  })

  test("offers marked providers OpenCode does not list yet, sorted by name", () => {
    const accounts = projectWebSearchAccounts([
      integration("exa", "Exa", { methods: keyAndEnv("EXA_API_KEY") }),
      integration("serper", "Serper", { metadata: { websearch: true }, methods: keyAndEnv("SERPER_API_KEY") }),
      searxng,
      integration("brave", "Brave Search", { metadata: { websearch: true }, methods: keyAndEnv("BRAVE_API_KEY") }),
      integration("openai", "OpenAI", { methods: keyAndEnv("OPENAI_API_KEY") }),
    ], ["exa", "brave"])
    expect(accounts.connectable).toEqual([
      { id: "searxng", name: "SearXNG" },
      { id: "serper", name: "Serper" },
    ])
    expect(Object.keys(accounts.access).sort()).toEqual(["brave", "exa", "searxng", "serper"])
    expect(accounts.access.serper).toEqual({ key: { kind: "none" }, envNames: ["SERPER_API_KEY"], connect: { kind: "key", fields: [] } })
  })

  test("a server form becomes a form method with its fields", () => {
    const accounts = projectWebSearchAccounts([searxng], [])
    expect(accounts.access.searxng?.connect).toEqual({
      kind: "form",
      methodID: "server",
      fields: [{ key: "url", label: "Server URL", description: null, placeholder: "https://searx.example.org", required: true, url: true }],
    })
  })

  test("a saved credential or an environment variable counts for a form method too", () => {
    const saved = projectWebSearchAccounts([{ ...searxng, connections: [{ type: "credential", id: "cred_1", label: "", method: "external" }] }], [])
    expect(saved.access.searxng?.key).toEqual({ kind: "stored", ids: ["cred_1"] })
    const env = projectWebSearchAccounts([{ ...searxng, connections: [{ type: "env", name: "SEARXNG_URL" }] }], [])
    expect(env.access.searxng?.key).toEqual({ kind: "env", name: "SEARXNG_URL" })
  })

  test("a form with fields the page cannot render leaves the provider to OpenCode", () => {
    const accounts = projectWebSearchAccounts([
      integration("choice", "Choice", {
        metadata: { websearch: true },
        methods: [{ type: "key", form: [{ key: "region", type: "string", options: [{ value: "eu", label: "EU" }] }] }],
      }),
    ], [])
    expect(accounts.access.choice).toEqual({ key: { kind: "unsupported" }, envNames: [], connect: null })
  })

  test("only metadata.websearch === true marks an integration", () => {
    expect(isWebSearchIntegration(integration("a", "A", { metadata: { websearch: true } }))).toBe(true)
    expect(isWebSearchIntegration(integration("b", "B", { metadata: { websearch: "yes" } }))).toBe(false)
    expect(isWebSearchIntegration(integration("c", "C"))).toBe(false)
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
