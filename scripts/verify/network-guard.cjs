// Preloaded into every Node and Bun process of a stand (guard.mjs). Refuses
// each connection that leaves this machine, and records a request to a model.
const fs = require("node:fs")
const net = require("node:net")
const http = require("node:http")
const https = require("node:https")

const LOG = process.env.OPENCHAMBER_VERIFY_GUARD_LOG
const MODEL_PATH = /\/(chat\/completions|completions|messages|responses|converse(-stream)?|embeddings)\b|:(stream)?generateContent\b/i
const MODEL_HOST = /(^|\.)(opencode\.ai|openai\.com|anthropic\.com|googleapis\.com|openrouter\.ai|x\.ai|z\.ai|deepseek\.com|mistral\.ai|groq\.com|amazonaws\.com)$/i

const record = (entry) => {
  try { fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`) } catch {}
}

const isLocal = (host) => {
  const name = String(host ?? "localhost").replace(/^\[|\]$/g, "").toLowerCase()
  return name === "" || name === "localhost" || name.endsWith(".localhost") || name === "::1" || name === "::" || name === "0.0.0.0" || /^(::ffff:)?127\./.test(name)
}

const refusal = (host) => Object.assign(new Error(`The verify stand refuses connections to ${host}`), { code: "ECONNREFUSED", syscall: "connect" })

const modelIn = (text) => {
  try {
    const model = JSON.parse(text)?.model
    return typeof model === "string" ? model : model?.id ?? null
  } catch { return null }
}

const recordRequest = (url, method, text) => {
  const model = modelIn(text) ?? /\/models\/([^/:]+)/.exec(url.pathname)?.[1] ?? null
  const asksModel = MODEL_PATH.test(url.pathname) || (method === "POST" && model !== null)
  record({ type: asksModel ? "model" : "blocked", host: url.hostname, path: url.pathname, model })
}

const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(async function fetch(input, init) {
  let url
  try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url) } catch { return originalFetch(input, init) }
  if (!/^(https?|wss?):$/.test(url.protocol) || isLocal(url.hostname) || init?.unix) return originalFetch(input, init)
  const request = new Request(input, init)
  recordRequest(url, request.method, request.body ? await request.text().catch(() => "") : "")
  throw Object.assign(new TypeError("fetch failed"), { cause: refusal(url.hostname), code: "ECONNREFUSED" })
}, originalFetch)

const refuseHost = (host) => {
  record({ type: MODEL_HOST.test(host) ? "model" : "blocked", host, path: null, model: null })
  return refusal(host)
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const options = first !== null && typeof first === "object" ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined }
  const local = options.path || options.fd !== undefined || (typeof options.port === "string" && !/^\d+$/.test(options.port)) || isLocal(options.host)
  if (local) return connect.apply(this, args)
  const error = refuseHost(String(options.host))
  process.nextTick(() => this.destroy(error))
  return this
}

if (process.versions.bun) {
  // Bun's own clients do not go through net.Socket.
  for (const [module, protocol] of [[http, "http:"], [https, "https:"]]) {
    const request = module.request
    module.request = function (...args) {
      const given = args.find((value) => value instanceof URL || typeof value === "string")
      const options = args.find((value) => value !== null && typeof value === "object" && !(value instanceof URL)) ?? {}
      const host = given ? new URL(given, `${protocol}//localhost`).hostname : options.hostname ?? options.host?.replace(/:\d+$/, "")
      if (!isLocal(host) && !options.socketPath) throw refuseHost(host)
      return request.apply(this, args)
    }
    module.get = function (...args) {
      const call = module.request(...args)
      call.end()
      return call
    }
  }
  const bunConnect = Bun.connect
  Bun.connect = (options) => options.unix || isLocal(options.hostname) ? bunConnect(options) : Promise.reject(refuseHost(options.hostname))
  try { Object.defineProperty(Bun, "fetch", { value: globalThis.fetch }) } catch {}
}

const OriginalWebSocket = globalThis.WebSocket
if (OriginalWebSocket) {
  globalThis.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args, newTarget) {
      const { hostname } = new URL(args[0])
      if (!isLocal(hostname)) throw refuseHost(hostname)
      return Reflect.construct(target, args, newTarget)
    },
  })
}

record({ type: "armed", argv: process.argv.slice(1) })
