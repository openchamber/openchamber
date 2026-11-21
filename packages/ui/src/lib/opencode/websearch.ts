
import type { IntegrationInfo } from "@opencode/client"
import { z } from "zod"
import { normalizeOpencodeError, opencodeClient, type OpenCodeClient } from "./client"
import type { Config, FormRequest, Metadata } from "./model"

export interface WebSearchProvider {
  id: string
  name: string
}

export type WebSearchSelection =
  // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/tool/plugin/websearch.ts Unset configuration uses the stored consent answer and asks only when no answer exists.
  | { kind: "default" }
  | { kind: "off" }
  | { kind: "random" }
  | { kind: "provider"; id: string }

export type WebSearchKeyStatus =
  | { kind: "unsupported" }
  | { kind: "none" }
  | { kind: "stored"; ids: string[] }
  | { kind: "env"; name: string }

export interface WebSearchConnectField {
  key: string
  label: string
  description: string | null
  placeholder: string | null
  required: boolean
  url: boolean
}

export type WebSearchConnectMethod =
  | { kind: "key"; fields: WebSearchConnectField[] }
  | { kind: "form"; methodID: string; fields: WebSearchConnectField[] }

export interface WebSearchProviderAccess {
  key: WebSearchKeyStatus
  envNames: string[]
  connect: WebSearchConnectMethod | null
}

export type WebSearchConnectAnswer = Record<string, string>

const clientFor = (directory: string | null): OpenCodeClient =>
  directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw normalizeOpencodeError(operation, error)
  }
}

export async function listWebSearchProviders(directory: string | null): Promise<WebSearchProvider[]> {
  const response = await call("websearch.providers", () => clientFor(directory).websearch.providers())
  return response.data.map((provider) => ({ id: provider.id, name: provider.name }))
}

export function readWebSearchSelection(config: Config): WebSearchSelection {
  const value = config.websearch
  if (value === undefined) return { kind: "default" }
  if (value === false) return { kind: "off" }
  if (value.provider === "random") return { kind: "random" }
  return { kind: "provider", id: value.provider }
}

export function webSearchSelectionToConfig(selection: WebSearchSelection): false | string | null {
  switch (selection.kind) {
    case "default":
      return null
    case "off":
      return false
    case "random":
      return "random"
    case "provider":
      return selection.id
  }
}

type IntegrationMethod = IntegrationInfo["methods"][number]
type FormField = NonNullable<Extract<IntegrationMethod, { type: "key" }>["form"]>[number]

export function isWebSearchIntegration(integration: IntegrationInfo): boolean {
  return integration.metadata?.websearch === true
}

function toConnectFields(form: readonly FormField[] | undefined): WebSearchConnectField[] | null {
  const fields: WebSearchConnectField[] = []
  for (const field of form ?? []) {
    if (field.type !== "string" || field.options?.length || field.when?.length) return null
    if (field.hidden) continue
    fields.push({
      key: field.key,
      label: field.title ?? field.key,
      description: field.description ?? null,
      placeholder: field.placeholder ?? null,
      required: field.required === true,
      url: field.format === "uri",
    })
  }
  return fields
}

function toConnectMethod(methods: readonly IntegrationMethod[]): WebSearchConnectMethod | null {
  for (const method of methods) {
    if (method.type !== "key") continue
    const fields = toConnectFields(method.form)
    if (fields) return { kind: "key", fields }
  }
  for (const method of methods) {
    if (method.type !== "external" || !method.form) continue
    const fields = toConnectFields(method.form)
    if (fields && fields.length > 0) return { kind: "form", methodID: method.id, fields }
  }
  return null
}

const toAccess = (integration: IntegrationInfo | undefined): WebSearchProviderAccess => {
  const methods = integration?.methods ?? []
  const envNames = methods.flatMap((method) => (method.type === "env" ? [...method.names] : []))
  const connect = toConnectMethod(methods)
  if (!connect) return { key: { kind: "unsupported" }, envNames, connect: null }
  const connections = integration?.connections ?? []
  const stored = connections.flatMap((connection) => (connection.type === "credential" ? [connection.id] : []))
  if (stored.length > 0) return { key: { kind: "stored", ids: stored }, envNames, connect }
  const env = connections.find((connection) => connection.type === "env")
  if (env?.type === "env") return { key: { kind: "env", name: env.name }, envNames, connect }
  return { key: { kind: "none" }, envNames, connect }
}

export interface WebSearchAccounts {
  access: Record<string, WebSearchProviderAccess>
  connectable: WebSearchProvider[]
}

export function projectWebSearchAccounts(
  integrations: readonly IntegrationInfo[],
  providerIds: readonly string[],
): WebSearchAccounts {
  const listed = new Set(providerIds)
  const connectable = integrations
    .filter((integration) => isWebSearchIntegration(integration) && !listed.has(integration.id))
    .map((integration) => ({ id: integration.id, name: integration.name || integration.id }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  const access: Record<string, WebSearchProviderAccess> = {}
  for (const id of [...providerIds, ...connectable.map((provider) => provider.id)]) {
    access[id] = toAccess(integrations.find((integration) => integration.id === id))
  }
  return { access, connectable }
}

export async function readWebSearchAccounts(
  directory: string | null,
  providerIds: readonly string[],
): Promise<WebSearchAccounts> {
  const response = await call("integration.list", () => clientFor(directory).integration.list())
  return projectWebSearchAccounts(response.data, providerIds)
}

export async function saveWebSearchCredential(
  directory: string | null,
  providerId: string,
  connect: WebSearchConnectMethod,
  input: { key: string; answer: WebSearchConnectAnswer },
): Promise<void> {
  const answer = Object.keys(input.answer).length > 0 ? input.answer : undefined
  const integration = clientFor(directory).integration
  if (connect.kind === "key") {
    await call("integration.connect.key", () => integration.connect.key({ integrationID: providerId, key: input.key, answer }))
    return
  }
  await call("integration.connect.external", () =>
    integration.connect.external({ integrationID: providerId, methodID: connect.methodID, answer }),
  )
}

export async function removeWebSearchKey(credentialIds: readonly string[]): Promise<void> {
  const sdk = opencodeClient.getSdkClient()
  for (const credentialID of credentialIds) {
    await call("credential.remove", () => sdk.credential.remove({ credentialID }))
  }
}


export interface WebSearchResult {
  url: string
  host: string
  title: string | null
  published: string | null
  snippet: string | null
}

export type WebSearchOutput = { kind: "results"; results: WebSearchResult[] } | { kind: "empty" }

const NO_RESULTS_PREFIX = "No search results found."
const HEADING = /^## \[(.*)\]\((https?:\/\/\S+)\)$/
const PUBLISHED = /^Published: (\S+)$/

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

export function parseWebSearchOutput(content: string): WebSearchOutput | null {
  const text = content.trim()
  if (text.startsWith(NO_RESULTS_PREFIX)) return { kind: "empty" }
  const lines = text.split("\n")
  if (!HEADING.test(lines[0] ?? "")) return null

  const results: WebSearchResult[] = []
  let current: { url: string; host: string; title: string | null; published: string | null; body: string[] } | null = null
  const flush = () => {
    if (!current) return
    const snippet = current.body.join("\n").trim()
    results.push({
      url: current.url,
      host: current.host,
      title: current.title,
      published: current.published,
      snippet: snippet.length > 0 ? snippet : null,
    })
  }

  for (const line of lines) {
    const heading = HEADING.exec(line)
    if (heading) {
      const [, title = "", url = ""] = heading
      const host = hostOf(url)
      if (!host) return null
      flush()
      current = { url, host, title: title && title !== url ? title : null, published: null, body: [] }
      continue
    }
    if (!current) return null
    const published = current.body.length === 0 && current.published === null ? PUBLISHED.exec(line) : null
    if (published) {
      current.published = published[1] ?? null
      continue
    }
    current.body.push(line)
  }
  flush()
  return { kind: "results", results }
}

const resultMetadataSchema = z.object({ provider: z.string().min(1) })

export function webSearchProviderOf(metadata: Metadata | undefined): string | null {
  return resultMetadataSchema.safeParse(metadata).data?.provider ?? null
}


export interface WebSearchConsentOption {
  value: string
  label: string
}

export type WebSearchConsent =
  | { step: "choice"; fieldKey: string; options: WebSearchConsentOption[] }
  | { step: "provider"; fieldKey: string; options: WebSearchConsentOption[] }

export function readWebSearchConsent(form: FormRequest): WebSearchConsent | null {
  if (form.metadata?.kind !== "websearch.provider") return null
  if (form.fields.length !== 1) return null
  const [field] = form.fields
  if (!field || field.type !== "string" || !field.options?.length) return null
  const options = field.options.map((option) => ({ value: option.value, label: option.label }))
  if (field.key === "choice") return { step: "choice", fieldKey: field.key, options }
  if (field.key === "provider") return { step: "provider", fieldKey: field.key, options }
  return null
}
