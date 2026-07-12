import { runtimeFetch } from "@/lib/runtime-fetch"

export function createSdkGlobalEventFetch(fetchRuntime: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const isGlobalEvent = request.method === "GET"
      && (url.pathname === "/global/event" || url.pathname === "/api/global/event")

    if (!isGlobalEvent) {
      return fetchRuntime(request)
    }

    const preservedInit: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    }

    return fetchRuntime(`/api/global/event${url.search}`, preservedInit)
  }
}

export const sdkGlobalEventFetch: typeof fetch = createSdkGlobalEventFetch(runtimeFetch)
